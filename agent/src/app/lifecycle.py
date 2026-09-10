"""Session lifecycle: on_session_end and entrypoint."""

from __future__ import annotations

import asyncio
import logging

from livekit import agents, api, rtc
from livekit.agents import ConversationItemAddedEvent

from domains.interview.evidence.tracker import InterviewEvidenceTracker
from domains.interview.runtime import (
    InterviewConfigError,
    InterviewRuntimeError,
    RuntimeServices,
    create_interview_runtime,
    make_runtime_report,
    prepare_runtime_prompt,
    resolve_interview,
)
from domains.screen import ScreenFeedbackRuntime
from domains.session import InteractionMode, build_agent_session
from infrastructure.config.profiles import ProfileError, pick_profile
from infrastructure.config.resources import (
    get_interview_catalog,
    get_or_create_turn_detector,
    get_prewarmed_turn_detector,
    get_profile_catalog,
    get_recording_config,
)
from infrastructure.logging.langfuse import flush_langfuse
from infrastructure.logging.tool_calls import attach_tool_call_logging
from infrastructure.monitoring.watchdog import (
    cancel_idle_room_watchdog,
    register_idle_room_watchdog,
)
from infrastructure.prompt import load_prompt
from services.identity.resolver import resolve_user_id_from_room_metadata
from services.simulation import install_answer_submit_shim, merge_simulation_userdata
from tools.interview.code_highlight import highlight_code_range

from .config import (
    CALLER_LOOKUP_TIMEOUT_SECONDS,
    EVIDENCE_TRACKER_CLOSE_TIMEOUT_SECONDS,
    RECORDING_START_AWAIT_TIMEOUT_SECONDS,
    SCREEN_FEEDBACK_CLOSE_TIMEOUT_SECONDS,
    SessionState,
    StartupTimer,
    _screen_feedback_runtimes,
    _session_usage_loggers,
    _sessions,
    build_recording_metadata,
    extract_session_config,
    parse_private_job_metadata,
    parse_room_metadata,
    plan_line,
    resolve_interaction_mode,
    resolve_interview_catalog_path,
    resolve_profile_config_path,
)
from .metrics import attach_metrics_logging
from .recording import (
    RecordingStartState,
    finalize_recording_session,
    post_completion_webhook,
    start_recording_for_session,
)
from .session import resolve_call_state, start_auto_session, start_ptt_session

logger = logging.getLogger("intervoo_agent")


async def on_session_end(ctx: agents.JobContext) -> None:
    cancel_idle_room_watchdog(ctx.room.name)

    screen_feedback = _screen_feedback_runtimes.pop(ctx.room.name, None)
    if screen_feedback is not None:
        try:
            await asyncio.wait_for(screen_feedback.close(), timeout=SCREEN_FEEDBACK_CLOSE_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            logger.error("Timed out closing screen feedback runtime room=%s", ctx.room.name)
        except Exception:
            logger.exception("Failed to close screen feedback runtime room=%s", ctx.room.name)

    state = _sessions.pop(ctx.room.name, None)
    if state is None:
        logger.info("No session state found for room %s", ctx.room.name)
        flush_langfuse()
        return

    if state.evidence_tracker is not None:
        try:
            await asyncio.wait_for(state.evidence_tracker.close(), timeout=EVIDENCE_TRACKER_CLOSE_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            logger.error("Timed out closing evidence tracker room=%s", ctx.room.name)
        except Exception:
            logger.exception("Failed to close evidence tracker room=%s", ctx.room.name)

    report_dict = make_runtime_report(ctx, state.interview_runtime)
    recording_result = await finalize_recording_session(state, ctx, report_dict)
    await post_completion_webhook(state, recording_result, report_dict)

    log_summary = _session_usage_loggers.pop(ctx.room.name, None)
    if log_summary is not None:
        log_summary()
    flush_langfuse()


async def entrypoint(ctx: agents.JobContext) -> None:
    timer = StartupTimer(ctx.room.name)
    userdata = ctx.proc.userdata
    room_metadata = ctx.job.room.metadata or ctx.room.metadata
    try:
        private_metadata = parse_private_job_metadata(ctx.job.metadata)
    except ValueError as error:
        logger.error(
            "Cannot parse private job metadata error_type=%s",
            type(error).__name__,
        )
        return
    metadata = (
        private_metadata
        if private_metadata is not None
        else parse_room_metadata(room_metadata)
    )
    simulation_ctx = ctx.simulation_context()
    metadata = merge_simulation_userdata(simulation_ctx, metadata)
    profile_catalog = get_profile_catalog(userdata, fallback_path=resolve_profile_config_path())

    try:
        profile = pick_profile(profile_catalog, metadata)
    except ProfileError as e:
        logger.error(f"Cannot resolve agent profile: {e}")
        return

    interview_catalog = get_interview_catalog(
        userdata,
        fallback_path=resolve_interview_catalog_path(),
    )
    try:
        resolved_interview = resolve_interview(
            metadata,
            profile=profile,
            catalog=interview_catalog,
        )
        runtime = create_interview_runtime(
            resolved=resolved_interview,
            profile=profile,
            metadata=metadata,
        )
        await runtime.prepare()
    except (InterviewConfigError, InterviewRuntimeError, RuntimeError, ValueError) as error:
        logger.error(
            "Cannot prepare interview runtime error_type=%s",
            type(error).__name__,
        )
        return

    mode = resolve_interaction_mode(metadata)
    session_config = extract_session_config(metadata)
    recording_metadata = build_recording_metadata(
        metadata,
        mode,
        profile,
        resume_mode=not runtime.uses_mock_pipeline,
    )
    timer.mark("metadata_profile")

    await ctx.connect()
    timer.mark("ctx_connect")
    register_idle_room_watchdog(ctx)

    @ctx.room.on("participant_disconnected")
    def on_disconnect(p: rtc.RemoteParticipant) -> None:
        logger.info(f"User disconnected: {p.identity}")

    initial_user_id = resolve_user_id_from_room_metadata(room_metadata)
    resolved_user_id, participant_identity, phone_number, _ = await resolve_call_state(ctx, initial_user_id)
    timer.mark("participant_lookup")

    if participant_identity is None:
        logger.warning("No participant joined within %ds room=%s", CALLER_LOOKUP_TIMEOUT_SECONDS, ctx.room.name)
        return

    agent_instructions, question_store, prompt_context = prepare_runtime_prompt(
        metadata=metadata,
        profile=profile,
        runtime=runtime,
        room_name=ctx.room.name,
        job_id=ctx.job.id,
        plan_line=plan_line,
    )
    if agent_instructions is None:
        return
    timer.mark("prompt_render")

    agent = None

    async def _inject_note(text, extra):
        if agent is not None:
            try:
                await agent.inject_internal_note(text, extra=extra)
            except Exception:
                logger.exception("Failed to inject note room=%s", ctx.room.name)

    async def _on_answer_submitted(qid):
        question_store.mark_answer_submitted(qid)
        await _inject_note(f"[Internal: candidate submitted answer for {qid}.]", {"internal_answer_submitted": qid})

    rec_cfg = get_recording_config(userdata)
    evidence_tracker = None
    recording_task = None
    try:
        evaluator_prompt = None
        is_mock = runtime.uses_mock_pipeline
        if is_mock:
            try:
                evaluator_prompt = load_prompt("prompts/interview/vasanth_evaluator.md")
            except Exception as e:
                logger.error("Failed to load evaluator prompt: %s", e)
                return
            evidence_tracker = InterviewEvidenceTracker(
                questions=question_store.internal_questions(),
                participant_identity=participant_identity,
                room_name=ctx.room.name,
                agent_type=profile.agent_type,
                recording_config=rec_cfg if rec_cfg.enabled else None,
                on_answer_submitted=_on_answer_submitted,
            )
            evidence_tracker.start(ctx.room)

        if rec_cfg.enabled:
            recording_task = asyncio.create_task(
                start_recording_for_session(config=rec_cfg, ctx=ctx, profile=profile, room_name=ctx.room.name,
                    resolved_user_id=resolved_user_id, participant_identity=participant_identity,
                    phone_number=phone_number, metadata=recording_metadata),
                name=f"recording-start:{ctx.room.name}",
            )

        screen_inspection_enabled = (
            profile.screen_inspection_enabled if runtime.uses_editor_events else False
        )
        timer_enabled = (
            profile.screen_feedback_timer_enabled if runtime.uses_editor_events else False
        )
        screen_feedback = None
        if runtime.uses_editor_events and (screen_inspection_enabled or timer_enabled):
            async def _on_screen_nudge(text):
                await _inject_note(text, {"internal_screen_nudge": True})

            async def _highlight_screen_feedback_code(from_line: int, to_line: int) -> None:
                await highlight_code_range(
                    room=ctx.room,
                    participant_identity=participant_identity,
                    from_line=from_line,
                    to_line=to_line,
                )

            screen_feedback = ScreenFeedbackRuntime(room=ctx.room, participant_identity=participant_identity,
                timer_enabled=timer_enabled, note_sink=_on_screen_nudge,
                code_highlight_sink=_highlight_screen_feedback_code)

        web_base = os.getenv("WEB_URL", "http://localhost:3000").rstrip("/")
        runtime_token = (
            metadata.get("runtimeToken")
            or metadata.get("runtime_token")
            or os.getenv("LLM_API_KEY", "token-pending")
        )

        session = build_agent_session(
            base_url=f"{web_base}/api/v1",
            api_key=str(runtime_token),
            tts_speaker=profile.voice_speaker, tts_dict_id=profile.voice_dict_id,
            mode=mode, session_config=session_config,
            turn_detector=get_or_create_turn_detector(userdata) if mode is InteractionMode.AUTO else get_prewarmed_turn_detector(userdata),
            disable_preemptive_generation=runtime.uses_editor_events,
            parallel_tool_calls=runtime.parallel_tool_calls_enabled,
        )
        attach_tool_call_logging(session)
        if runtime.content_tracing_enabled:
            _session_usage_loggers[ctx.room.name] = attach_metrics_logging(
                session,
                ctx.room.name,
            )

        @session.on("conversation_item_added")
        def on_item(event: ConversationItemAddedEvent):
            runtime.on_conversation_item(event.item)
            if evidence_tracker is not None:
                evidence_tracker.on_conversation_item(event.item)

        if evidence_tracker is not None:
            if simulation_ctx is not None:
                install_answer_submit_shim(session, evidence_tracker=evidence_tracker, metadata=metadata)

        async def _on_question_started(q):
            if evidence_tracker is not None:
                evidence_tracker.on_question_started(q)
            if screen_feedback is not None:
                await screen_feedback.on_question_started(q)

        async def _close_resume_room() -> None:
            try:
                await ctx.api.room.delete_room(
                    api.DeleteRoomRequest(room=ctx.room.name)
                )
            except api.TwirpError as error:
                if error.code != api.TwirpErrorCode.NOT_FOUND:
                    raise

        def _shutdown_resume_job() -> None:
            ctx.shutdown(reason="resume_mastery_finished")

        tools = runtime.build_tools(
            RuntimeServices(
                ctx=ctx,
                participant_identity=participant_identity,
                question_store=question_store,
                evidence_tracker=evidence_tracker,
                evaluator_prompt=evaluator_prompt,
                prompt_context={} if is_mock else prompt_context,
                userdata=userdata,
                on_question_started=_on_question_started,
                on_plan_loaded=(
                    lambda questions: evidence_tracker.load_plan(questions)
                    if evidence_tracker
                    else None
                ),
                screen_feedback=screen_feedback,
                screen_inspection_enabled=screen_inspection_enabled,
                close_room=_close_resume_room,
                shutdown_job=_shutdown_resume_job,
            )
        )

        if screen_feedback is not None and screen_inspection_enabled:
            agent_instructions += ("\n\nDuring an active coding question, use read_code_range followed by "
                "highlight_code only when meaningful editor code exists; never use "
                "inspect_shared_screen for coding. Call inspect_shared_screen only for an active "
                "whiteboard request. Never claim that you cannot "
                "see the candidate's screen. If the result includes candidate_message, say it and "
                "continue the interview. Treat screen_share_required, surface_unavailable, and loading "
                "as normal recoverable states; never call end_call because of them.")

        timer.mark("tool_build")

        agent = runtime.build_agent(
            instructions=agent_instructions,
            tools=tools,
            prompt_context=prompt_context,
            participant_identity=participant_identity,
            room_name=ctx.room.name,
        )
        timer.mark("session_build")

        webhook_url_raw = metadata.get("webhook_url")
        if isinstance(webhook_url_raw, str) and webhook_url_raw.strip():
            webhook_url = (
                f"{web_base}{webhook_url_raw}"
                if webhook_url_raw.startswith("/")
                else webhook_url_raw.strip()
            )
        else:
            webhook_url = f"{web_base}/api/sessions/webhook"

        recording_start = await recording_task if recording_task is not None else RecordingStartState()
        timer.mark("recording_start")

        _sessions[ctx.room.name] = SessionState(
            profile=profile, room_name=ctx.room.name, resolved_user_id=resolved_user_id,
            participant_identity=participant_identity, phone_number=phone_number, webhook_url=webhook_url,
            recording_config=rec_cfg if rec_cfg.enabled else None,
            recording_session_id=recording_start.recording_session_id, egress_id=recording_start.egress_id,
            audio_url=recording_start.audio_url, audio_s3_key=recording_start.audio_s3_key,
            video_egress_id=recording_start.video_egress_id, video_url=recording_start.video_url,
            video_s3_key=recording_start.video_s3_key, evidence_tracker=evidence_tracker,
            interview_runtime=runtime,
        )

        avatar_request = metadata.get("avatar")
        from services.agent.avatar import start_avatar
        await start_avatar(session, ctx.room, enabled=avatar_request is True or avatar_request == "liveavatar")
        timer.mark("avatar_start")

        start_session = start_ptt_session if mode is InteractionMode.PTT else start_auto_session
        if runtime.content_tracing_enabled:
            await start_session(ctx, session, agent)
        else:
            await start_session(
                ctx,
                session,
                agent,
                recording_options={
                    "audio": True,
                    "traces": True,
                    "logs": False,
                    "transcript": False,
                },
            )

        if screen_feedback is not None:
            try:
                await screen_feedback.start(session)
                _screen_feedback_runtimes[ctx.room.name] = screen_feedback
            except Exception:
                logger.exception("Failed to start screen feedback room=%s", ctx.room.name)
                await screen_feedback.close()
        timer.mark("session_start")
    except Exception:
        logger.exception("Session startup failed room=%s", ctx.room.name)
        recording_start = RecordingStartState()
        if recording_task is not None:
            try:
                recording_start = await asyncio.wait_for(
                    recording_task,
                    timeout=RECORDING_START_AWAIT_TIMEOUT_SECONDS,
                )
            except Exception:
                logger.error(
                    "Recording start task did not finish during cleanup room=%s",
                    ctx.room.name,
                )
        if ctx.room.name not in _sessions:
            _sessions[ctx.room.name] = SessionState(
                profile=profile, room_name=ctx.room.name,
                resolved_user_id=resolved_user_id,
                participant_identity=participant_identity, phone_number=phone_number,
                webhook_url=None,
                recording_config=rec_cfg if rec_cfg.enabled else None,
                recording_session_id=recording_start.recording_session_id,
                egress_id=recording_start.egress_id,
                audio_url=recording_start.audio_url,
                audio_s3_key=recording_start.audio_s3_key,
                video_egress_id=recording_start.video_egress_id,
                video_url=recording_start.video_url,
                video_s3_key=recording_start.video_s3_key,
                evidence_tracker=evidence_tracker,
                interview_runtime=runtime,
            )
        raise

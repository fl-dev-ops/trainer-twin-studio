"""Screen feedback prompts for vision analysis."""

SCREEN_FEEDBACK_INTERVAL_SECONDS = 10
SCREEN_FEEDBACK_COOLDOWN_SECONDS = 30
SCREEN_FEEDBACK_STALL_SECONDS = 60
SCREEN_FEEDBACK_CONFIDENCE_THRESHOLD = 0.8
RESUME_FRAME_WAIT_SECONDS = 10
# Upper bound on inspected viewports before the resume path finalizes with
# whatever has been accumulated. Prevents an endless scroll loop when the vision
# model never returns a confident apparent_end for the document's true bottom.
RESUME_MAX_VIEWPORTS = 6
SURFACE_STATE_TOPIC = "candidate.surface_state"
SUPPORTED_SURFACES = ("code", "whiteboard")

SCREEN_SHARE_REQUIRED_MESSAGE = (
    "Please share your entire screen and keep the active code editor or whiteboard "
    "visible so I can look at your work and guide you."
)
RESUME_SCREEN_SHARE_REQUIRED_MESSAGE = (
    "Please share your screen, open your resume, and keep the resume clearly visible. "
    "Tell me when it is ready."
)

ON_DEMAND_ANALYSIS_PROMPT = (
    "Inspect the candidate's current shared whiteboard for their explicit request. "
    "In feedback, first state one concrete detail visibly present "
    "in their work, then give one small Socratic hint or next step. Do not give the "
    "full solution. Use plain spoken text under forty-five words with no code or "
    "formatting. Set should_speak to true. Confidence reflects how clearly the "
    "relevant work is visible. Keep reason short and internal."
)
DEVIATION_ANALYSIS_PROMPT = (
    "You are a silent technical interview observer checking whether the candidate's "
    "current technique is fundamentally non-viable. Set should_speak to true only "
    "when the visible approach has no credible path to a correct solution without "
    "changing strategy, or shows a clear conceptual misconception. Incomplete code, "
    "ordinary syntax mistakes, missing edge cases, inefficiency, and viable "
    "alternative approaches do not qualify. If should_speak is true, briefly name the "
    "strategic concern as a statement so they can reconsider their technique. Never "
    "give the full answer. Never ask the candidate a question and never end feedback "
    "with a question mark; this is an aside while they keep working, not a turn in the "
    "interview. Use one or two short sentences under thirty words with plain spoken "
    "text and no code or formatting. Do not repeat the last visual nudge."
)
STALL_ANALYSIS_PROMPT = (
    "You are a silent technical interview observer. The candidate has made no code "
    "or whiteboard progress for at least sixty seconds. For Coding and Machine coding "
    "questions, estimate the percentage of the requested implementation visibly "
    "completed and return it in code_completion_percent. At fifty percent or greater, "
    "set should_speak to true only when there is a meaningful question about one "
    "specific visible code block. Put that targeted Socratic question in feedback and "
    "return the smallest inclusive one-based line range for that block in "
    "highlight_from_line and highlight_to_line. If no meaningful question exists, set "
    "should_speak to false and leave both line fields null. Below fifty percent, "
    "feedback may stay general and both line fields must be null. For whiteboards, "
    "leave code_completion_percent and both line fields null. "
    "When should_speak is true, use feedback for one small Socratic question, hint, "
    "or technique that can restart progress. Never give the full answer. Feedback must be one or two "
    "short sentences under thirty words, with plain spoken text and no code or "
    "formatting. Do not repeat the last visual nudge."
)
RESUME_VIEWPORT_ANALYSIS_PROMPT = (
    "You inspect one visible viewport of a candidate's resume. Extract only "
    "professional information: education, work experience, company names, role "
    "titles, skills, projects, and certifications. Never extract or repeat the "
    "candidate's name, email, phone number, address, photograph, links, identifiers, "
    "or other personal contact information. The accumulated resume state is supplied "
    "as text. Return facts visible in the current viewport even when they overlap "
    "with accumulated facts; the application deduplicates them. Do not infer facts "
    "that are not visible. Set end_state to more_content when text is clipped at the "
    "bottom, a visible page counter is not on its final page, or a scrollbar is "
    "clearly above the bottom. Set apparent_end only when there is positive visual "
    "evidence that the document ends here, such as the final PDF page together with "
    "an unclipped bottom, or a scrollbar at the bottom with an unclipped resume "
    "footer or bottom margin. Otherwise set uncertain. Keep end_reason short and "
    "grounded in visible evidence. When more_content is selected, provide one precise "
    "plain-spoken scroll_instruction telling the candidate what remains clipped or "
    "which next page to show."
)
RESUME_NORMALIZATION_PROMPT = (
    "Normalize accumulated professional resume facts. Consolidate exact and semantic "
    "duplicates while preserving every distinct observed fact. Keep the supplied "
    "categories. Do not infer missing dates, employers, titles, technologies, "
    "responsibilities, project outcomes, or experience duration. Never include names, "
    "email addresses, phone numbers, addresses, photographs, links, identifiers, or "
    "other personal contact information. Return only the structured resume details."
)

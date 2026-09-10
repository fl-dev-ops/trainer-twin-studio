"""Chroma connection and interview-plan retrieval."""

from __future__ import annotations

import json
import logging
import os
import re
import time
from collections.abc import MutableMapping
from typing import Any

from domains.interview.config import (
    BUCKET_ORDER,
    BUCKETS,
    COUNTS,
    DEFAULT_DOMAINS,
    DEFAULT_STARTER_CODE,
    DIFFICULTIES,
    SUPPORTED_LANGUAGES,
)

logger = logging.getLogger(__name__)

LOG_PREFIX = "[EXT-API:chroma]"

USERDATA_CHROMA_CLIENT = "chroma_client"
USERDATA_CHROMA_COLLECTION = "chroma_collection"

_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)


def _chroma_settings() -> dict[str, str]:
    return {
        "api_key": os.getenv("CHROMA_API_KEY", ""),
        "tenant": os.getenv("CHROMA_TENANT", ""),
        "database": os.getenv("CHROMA_DATABASE", ""),
        "collection": os.getenv("CHROMA_COLLECTION", ""),
    }


def _safe_identity() -> str:
    settings = _chroma_settings()
    return (
        f"tenant={settings['tenant']!r} database={settings['database']!r} "
        f"collection={settings['collection']!r}"
    )


def chroma_runtime_identity() -> str:
    return _safe_identity()


def chroma_configured() -> bool:
    return all(_chroma_settings().values())


def get_cached_collection(userdata: MutableMapping[str, Any]) -> Any:
    collection = userdata.get(USERDATA_CHROMA_COLLECTION)
    if collection is not None:
        return collection

    settings = _chroma_settings()
    if not all(settings.values()):
        raise ValueError(
            "Chroma not configured: set CHROMA_API_KEY, CHROMA_TENANT, "
            "CHROMA_DATABASE and CHROMA_COLLECTION"
        )

    import chromadb

    started = time.monotonic()
    client = userdata.get(USERDATA_CHROMA_CLIENT)
    if client is None:
        client = chromadb.CloudClient(
            api_key=settings["api_key"],
            tenant=settings["tenant"],
            database=settings["database"],
        )
        userdata[USERDATA_CHROMA_CLIENT] = client

    collection = client.get_collection(settings["collection"])
    userdata[USERDATA_CHROMA_COLLECTION] = collection
    logger.info(
        "%s connected %s count=%d elapsed_ms=%d",
        LOG_PREFIX,
        _safe_identity(),
        collection.count(),
        int((time.monotonic() - started) * 1000),
    )
    return collection


def prewarm_chroma(userdata: MutableMapping[str, Any]) -> None:
    if not chroma_configured():
        return
    started = time.monotonic()
    try:
        collection = get_cached_collection(userdata)
        collection.count()
        logger.info(
            "%s prewarmed %s elapsed_ms=%d",
            LOG_PREFIX,
            _safe_identity(),
            int((time.monotonic() - started) * 1000),
        )
    except Exception as e:
        logger.warning("%s prewarm failed: %s", LOG_PREFIX, e)


def _build_where(
    types: list[str] | None,
    difficulties: list[str] | None,
    domains: list[str] | None,
    surface: str | None,
    source_context: str | None,
) -> dict[str, Any]:
    conditions: list[dict[str, Any]] = []
    if types:
        conditions.append({"question_type": {"$in": types}})
    if difficulties:
        conditions.append({"difficulty_level": {"$in": difficulties}})
    if domains:
        conditions.append({"domain": {"$in": domains}})
    if surface:
        conditions.append({"surface": surface})
    if source_context:
        conditions.append({"source_context": source_context})
    if not conditions:
        return {}
    if len(conditions) == 1:
        return conditions[0]
    return {"$and": conditions}


def _query(
    collection: Any,
    *,
    query_text: str | None,
    types: list[str] | None,
    difficulties: list[str] | None,
    domains: list[str] | None,
    surface: str | None,
    source_context: str | None,
    n: int,
    exclude_ids: set[str],
) -> list[tuple[str, dict[str, Any]]]:
    where = _build_where(types, difficulties, domains, surface, source_context)
    started = time.monotonic()
    result = collection.query(
        query_texts=[query_text or "interview"],
        n_results=n + len(exclude_ids),
        where=where,
        include=["metadatas", "distances"],
    )
    ids = (result.get("ids") or [[]])[0]
    metas = (result.get("metadatas") or [[]])[0]
    rows = [
        (qid, meta or {})
        for qid, meta in zip(ids, metas, strict=False)
        if isinstance(qid, str) and qid not in exclude_ids
    ]
    logger.info(
        "%s query %s filters=%s requested=%d returned=%d elapsed_ms=%d",
        LOG_PREFIX,
        _safe_identity(),
        where,
        n,
        len(rows),
        int((time.monotonic() - started) * 1000),
    )
    return rows


def _record(meta: dict[str, Any]) -> dict[str, Any]:
    raw = meta.get("record_json")
    if not isinstance(raw, str):
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _spoken(text: str) -> str:
    stripped = _FENCE_RE.sub("", text).strip()
    return stripped or text.strip()


def _language(record: dict[str, Any], meta: dict[str, Any]) -> str:
    code = record.get("code")
    raw = record.get("editorLanguage") or meta.get("editor_language")
    if not raw:
        raw = (
            code.get("language")
            if isinstance(code, dict)
            else meta.get("code_language")
        )
    language = str(raw or "").lower()
    if language in SUPPORTED_LANGUAGES:
        return language
    if language in {"jsx", "tsx", "ts"}:
        return "react"
    if "react" in _string_list(record.get("domain")):
        return "react"
    return "javascript"


def _normalize(qid: str, meta: dict[str, Any]) -> dict[str, Any] | None:
    record = _record(meta)
    text = str(record.get("question") or meta.get("question") or "").strip()
    if not text:
        return None

    question_type = str(
        record.get("questionType") or meta.get("question_type") or "verbal"
    ).strip()
    if question_type in {"coding", "machine-coding"}:
        surface, answer_mode, response_mode = "code", "surface", "code"
    elif question_type == "code-output":
        surface, answer_mode, response_mode = "code", "verbal", "verbal"
    elif question_type == "mcq":
        surface, answer_mode, response_mode = "choice", "surface", "choice"
    else:
        explicit_surface = str(record.get("surface") or "").strip().lower()
        surface = explicit_surface if explicit_surface == "whiteboard" else "verbal"
        answer_mode = "surface" if surface == "whiteboard" else "verbal"
        response_mode = str(record.get("responseMode") or "verbal")

    options = _string_list(record.get("options"))
    answer = record.get("answer")
    normalized_answer: dict[str, str] | None = None
    if question_type == "mcq":
        if not isinstance(answer, dict):
            return None
        correct_option = answer.get("correctOption")
        explanation = answer.get("explanation")
        if (
            not isinstance(correct_option, str)
            or options.count(correct_option) != 1
            or not isinstance(explanation, str)
            or not explanation.strip()
        ):
            return None
        normalized_answer = {
            "correctOption": correct_option,
            "explanation": explanation.strip(),
        }

    code = record.get("code")
    language = _language(record, meta)
    starter_code = (
        code.get("content", "").strip()
        if isinstance(code, dict) and isinstance(code.get("content"), str)
        else ""
    )
    if surface == "code" and answer_mode == "surface" and not starter_code:
        starter_code = DEFAULT_STARTER_CODE.get(language, "")
    normalized: dict[str, Any] = {
        "id": qid,
        "text": text,
        "spokenText": _spoken(text),
        "questionType": question_type,
        "responseMode": response_mode,
        "surface": surface,
        "answerMode": answer_mode,
        "difficulty": str(
            record.get("difficulty") or meta.get("difficulty_level") or ""
        ),
        "domain": _string_list(record.get("domain")),
        "topics": _string_list(record.get("topics")),
    }
    if surface == "code" or (question_type == "mcq" and starter_code):
        normalized["language"] = language
        normalized["starterCode"] = starter_code
    if question_type == "mcq":
        normalized["options"] = options
        normalized["answer"] = normalized_answer
    return normalized


def _fill_bucket(
    collection: Any,
    *,
    query_text: str,
    types: list[str],
    difficulties: list[str],
    domains: list[str],
    target: int,
    exclude_ids: set[str],
    required_surface: str | None = None,
    allow_domain_fallback: bool = True,
    source_context: str | None = None,
) -> list[dict[str, Any]]:
    picked: dict[str, dict[str, Any]] = {}
    fallbacks = (
        [(domains, difficulties), (None, difficulties), (None, None)]
        if allow_domain_fallback
        else [(domains, difficulties), (domains, None)]
    )
    for selected_domains, selected_difficulties in fallbacks:
        if len(picked) >= target:
            break
        rows = _query(
            collection,
            query_text=query_text,
            types=types,
            difficulties=selected_difficulties,
            domains=selected_domains,
            surface=required_surface,
            source_context=source_context,
            n=max(target * 4, target),
            exclude_ids=exclude_ids | set(picked),
        )
        for question_id, metadata in rows:
            normalized = _normalize(question_id, metadata)
            if normalized is None:
                continue
            if required_surface is not None and normalized.get("surface") != required_surface:
                continue
            if required_surface is None and normalized.get("surface") == "whiteboard":
                continue
            picked[question_id] = normalized
            if len(picked) >= target:
                break
    return list(picked.values())[:target]


def _band(years_experience: object) -> str:
    try:
        years = int(years_experience)
    except (ValueError, TypeError):
        years = 0
    return "0-3" if years <= 3 else "4-8"


def build_plan(
    collection: Any,
    *,
    years_experience: int,
    domains: list[str] | None,
    focus: str,
) -> tuple[str, dict[str, int], list[dict[str, Any]]]:
    band = _band(years_experience)
    difficulties = DIFFICULTIES[band]
    selected_domains = [
        domain.strip().lower()
        for domain in (domains or DEFAULT_DOMAINS)
        if isinstance(domain, str) and domain.strip()
    ] or DEFAULT_DOMAINS
    counts = COUNTS[band]
    query_text = (focus or " ".join(selected_domains)).strip()

    ordered: list[dict[str, Any]] = []
    used: set[str] = set()
    for bucket in BUCKET_ORDER:
        target = counts[bucket]
        if target == 0:
            continue
        bucket_config = BUCKETS[bucket]
        questions = _fill_bucket(
            collection,
            query_text=query_text,
            types=bucket_config["question_types"],
            difficulties=difficulties,
            domains=bucket_config.get("domains", selected_domains),
            target=target,
            exclude_ids=used,
            required_surface=bucket_config.get("surface"),
            allow_domain_fallback=bucket_config.get("allow_domain_fallback", True),
            source_context=bucket_config.get("source_context"),
        )
        ordered.extend(questions)
        used.update(question["id"] for question in questions)
    return band, counts, ordered

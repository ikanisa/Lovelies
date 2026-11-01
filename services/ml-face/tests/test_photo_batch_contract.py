"""Exercise production DTOs/functions with a synthetic query provider.

No native image inference, model weights, external service or recognition
accuracy is asserted. AST extraction avoids booting the resident model child.
"""
from __future__ import annotations
import ast
import base64
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Literal
import uuid

import numpy as np
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field, ValidationError
import pytest

from pictured_ml_face.models import CandidateEmbedding, FaceEmbedding, MatchDecision, MatchRequest, PhotoProcessRequest
from pictured_ml_face.vector_matching import rank_candidate_distances


class Failure(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status_code = status


def production_contract():
    source = Path(__file__).parents[1] / 'src/lovelies_ml_face/app.py'
    names = {'Strict', 'Capture', 'Template', 'Profile', 'PhotoJob', 'PhotoBatchJob', 'FaceJob', 'Binding',
             'BoundFaceJob', 'BoundPhotoJob', 'BoundPhotoBatchJob', 'bound_result', 'bytes_for', 'template_for', 'photo_result'}
    body = [node for node in ast.parse(source.read_text()).body if getattr(node, 'name', '') in names]
    identity = {'engine_artifact_sha256': 'a' * 64, 'processing_fingerprint': 'b' * 64}
    pipeline = SimpleNamespace(identity=identity, process_photo_bytes=lambda *_: SimpleNamespace(faces=[
        SimpleNamespace(embedding=[1.0] + [0.0] * 127)]))
    scope = {**globals(), 'MAX_IMAGE': 20 * 1024 * 1024, 'TEMPLATE_PROTOCOL': 'lovelies-face-template-v2',
             'MODEL': 'opencv-yunet-sface-2021dec-v1', 'ENGINE_SPACE': 'lovelies-sface-openface-still-v1',
             'pipeline': pipeline, 'HTTPException': Failure, 'ModelPolicyError': ValueError,
             'parse_json_object': lambda raw, _label: json.loads(raw)}
    exec(compile(ast.Module(body=body, type_ignores=[]), str(source), 'exec'), scope)
    for name in names:
        value = scope[name]
        if isinstance(value, type) and issubclass(value, BaseModel):
            value.model_rebuild(_types_namespace=scope)
    return scope


def payload(scope, *, preview=False, distance=.1):
    raw = io.BytesIO()
    Image.new('RGB', (10, 20), 'white').save(raw, 'PNG')
    source = raw.getvalue()
    similarity = 1 - distance
    vector = [similarity, (1 - similarity * similarity) ** .5] + [0.0] * 126
    template = {'protocol': scope['TEMPLATE_PROTOCOL'], 'model_id': scope['MODEL'], 'engine_space': scope['ENGINE_SPACE'],
                **scope['pipeline'].identity, 'embeddings': [vector, vector, vector]}
    encoded = json.dumps(template, separators=(',', ':')).encode()
    return {'asset_id': str(uuid.uuid4()), 'source': {'mime': 'image/png', 'sha256': hashlib.sha256(source).hexdigest(),
            'bytes_base64': base64.b64encode(source).decode()}, 'profiles': [{'account_id': str(uuid.uuid4()), 'profile_id': str(uuid.uuid4()),
            'revision': 'synthetic-v1', 'model_id': scope['MODEL'], 'template_digest': hashlib.sha256(encoded).hexdigest(),
            'template_base64': base64.b64encode(encoded).decode()}], 'ranking_protocol': 'lovelies-photo-ranking-page-v1', 'include_preview': preview}


def test_page_returns_scores_with_stable_query_binding_but_no_acceptance_or_embeddings():
    scope = production_contract()
    first = payload(scope)
    other = payload(scope, preview=True, distance=.12)
    other['asset_id'] = first['asset_id']
    result = scope['photo_result'](scope['PhotoBatchJob'](**first))
    final = scope['photo_result'](scope['PhotoBatchJob'](**other))
    assert result['ranking']['query_sha256'] == final['ranking']['query_sha256']
    assert result['ranking']['faces'][0]['candidates'][0]['distance'] == pytest.approx(.1, abs=1e-6)
    assert final['ranking']['faces'][0]['candidates'][0]['distance'] == pytest.approx(.12, abs=1e-6)
    assert result['ranking']['threshold'] == .42 and result['ranking']['review_margin'] == .05
    assert set(result) == {'model_version', 'ranking'}
    assert set(final) == {'model_version', 'ranking', 'preview'}
    assert 'embeddings' not in json.dumps(result) and 'matches' not in result


def test_batch_request_hash_includes_exact_page_protocol_and_preview_selection():
    scope = production_contract()
    value = {**payload(scope), 'engine_space': scope['ENGINE_SPACE'], **scope['pipeline'].identity, 'request_id': str(uuid.uuid4())}
    value['request_sha256'] = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    result = scope['bound_result'](scope['BoundPhotoBatchJob'](**value), scope['photo_result'])
    assert result['request_sha256'] == value['request_sha256']
    value['include_preview'] = True
    with pytest.raises(Failure, match='inference_binding_invalid'):
        scope['bound_result'](scope['BoundPhotoBatchJob'](**value), scope['photo_result'])


def test_batch_count_and_unknown_protocol_are_rejected_before_model_work():
    scope = production_contract()
    value = payload(scope)
    value['profiles'] *= 129
    with pytest.raises(ValidationError):
        scope['PhotoBatchJob'](**value)
    value = payload(scope)
    value['ranking_protocol'] = 'old-page-assumed-safe'
    with pytest.raises(ValidationError):
        scope['PhotoBatchJob'](**value)

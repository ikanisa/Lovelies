"""Private wire binding; real engine execution is exercised separately."""
import base64
import hashlib
import json
import os
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from lovelies_ml_face import app as adapter
from test_private_adapters import capture


def bound(**changes):
    payload = {
        'engine_space': adapter.ENGINE_SPACE,
        'engine_artifact_sha256': adapter.pipeline.identity['engine_artifact_sha256'],
        'processing_fingerprint': adapter.pipeline.identity['processing_fingerprint'],
        'request_id': 'b71974bc-4a53-4ffb-bdf8-2ea4d15f5862',
        'reference_mode': 'first_registration',
        'captures': [capture(index) for index in range(3)],
        **changes,
    }
    payload['request_sha256'] = hashlib.sha256(json.dumps(
        payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
    ).encode()).hexdigest()
    return payload


def test_wire_hash_preserves_omitted_optional_reference_fields_and_echoes_binding():
    payload = bound()
    result = adapter.bound_result(adapter.BoundFaceJob.model_validate(payload), adapter.face_result)
    assert result['identity_verified'] is True
    for field in adapter.Binding.model_fields:
        assert result[field] == payload[field]
    template = json.loads(base64.b64decode(result['template_base64']))
    assert template['protocol'] == 'lovelies-face-template-v2'
    assert template['processing_fingerprint'] == payload['processing_fingerprint']


@pytest.mark.parametrize('field', ['request_sha256', 'processing_fingerprint', 'engine_artifact_sha256'])
def test_wrong_binding_is_rejected_before_inference(field):
    payload = bound()
    payload[field] = '0' * 64
    handler = Mock(side_effect=AssertionError('Inference must not be reached'))
    with pytest.raises(HTTPException, match='inference_binding_invalid'):
        adapter.bound_result(adapter.BoundFaceJob.model_validate(payload), handler)
    handler.assert_not_called()


def test_recomputed_hash_cannot_select_another_engine():
    payload = bound(processing_fingerprint='0' * 64)
    with pytest.raises(HTTPException, match='inference_binding_invalid'):
        adapter.bound_result(adapter.BoundFaceJob.model_validate(payload), Mock())


def test_http_requires_binding_and_never_echoes_input():
    with TestClient(adapter.app, raise_server_exceptions=False, headers={'Authorization':'Bearer '+os.environ['ML_INFERENCE_SECRET']}) as client:
        payload = bound()
        for field in adapter.Binding.model_fields:
            unbound = {key: value for key, value in payload.items() if key != field}
            response = client.post('/internal/face', json=unbound)
            assert response.status_code == 400
            assert 'bytes_base64' not in response.text
        payload['request_id'] = 'c71974bc-4a53-4ffb-bdf8-2ea4d15f5862'
        assert client.post('/internal/face', json=payload).status_code == 409


def test_ready_fails_when_resident_worker_is_not_loaded(monkeypatch):
    monkeypatch.setattr(adapter.pipeline, 'ready', lambda: False)
    with TestClient(adapter.app, raise_server_exceptions=False, headers={'Authorization':'Bearer '+os.environ['ML_INFERENCE_SECRET']}) as client:
        assert client.get('/ready').status_code == 503

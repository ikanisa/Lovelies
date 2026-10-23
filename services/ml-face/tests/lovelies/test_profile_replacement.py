"""Real-model A03 tests; static photographs do not prove camera or identity."""
import base64
import hashlib
import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from lovelies_ml_face.app import FaceJob, face_result, MODEL
from test_private_adapters import capture, registered, ASSETS


def test_replacement_compares_every_capture_and_emits_a_bound_new_reference():
    old = registered()
    new = face_result(FaceJob(reference_mode='replace_reference',
        captures=[capture(i + 3) for i in range(3)],
        reference_base64=old['template_base64'], reference_digest=old['template_sha256']))
    assert new['identity_verified'] and new['reference_match'] and new['enrollment_verified']
    raw = base64.b64decode(new['template_base64'], validate=True)
    assert hashlib.sha256(raw).hexdigest() == new['template_sha256']
    assert new['template_sha256'] != old['template_sha256']
    template = json.loads(raw)
    assert template['model_id'] == MODEL and len(template['embeddings']) == 3
    assert face_result(FaceJob(reference_mode='existing_reference', captures=[capture(4)],
        reference_base64=new['template_base64'], reference_digest=new['template_sha256']))['reference_match']


def test_replacement_cannot_drop_the_exact_old_reference_or_use_one_capture():
    with pytest.raises(HTTPException, match='registered_reference_required'):
        face_result(FaceJob(reference_mode='replace_reference', captures=[capture(i) for i in range(3)]))
    old = registered()
    with pytest.raises(HTTPException, match='capture_count_invalid'):
        face_result(FaceJob(reference_mode='replace_reference', captures=[capture()],
            reference_base64=old['template_base64'], reference_digest=old['template_sha256']))
    with pytest.raises(HTTPException, match='registered_reference_invalid'):
        face_result(FaceJob(reference_mode='replace_reference', captures=[capture(i) for i in range(3)],
            reference_base64=old['template_base64'], reference_digest='0' * 64))


def test_another_face_cannot_replace_the_registered_owner():
    old = registered()
    # These declared reference fixtures are the separately enrolled Eric input.
    fixture = Path(__file__).parents[4] / 'verification/docker-native-journey-20261013/fixtures'
    wrong = face_result(FaceJob(reference_mode='replace_reference',
        captures=[capture(i, fixture / ('eric-selfie-' + str(i) + '.jpg')) for i in range(3)],
        reference_base64=old['template_base64'], reference_digest=old['template_sha256']))
    assert wrong['identity_verified'] is False
    assert 'template_base64' not in wrong

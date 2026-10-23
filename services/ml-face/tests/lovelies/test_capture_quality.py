"""A04 private quality reasons. Static photographs are not camera qualification."""
import base64
import hashlib
import io
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image
from fastapi import HTTPException
from lovelies_ml_face.app import FaceJob, face_result, pipeline
from test_private_adapters import capture, registered

ROOT = Path(__file__).parents[4]

def encoded(raw, mime='image/jpeg'):
    return {'mime':mime,'sha256':hashlib.sha256(raw).hexdigest(),'bytes_base64':base64.b64encode(raw).decode()}

def assert_rejected(value, code):
    assert value['identity_verified'] is False
    assert value['capture_rejection'] == {'code':code,'capture_index':0}
    assert not any(key in value for key in ['template_base64','template_sha256','registered_reference','quality_score','embeddings'])

def test_actual_plain_image_is_a_bounded_no_face_rejection():
    stream=io.BytesIO();Image.new('RGB',(256,256),'white').save(stream,format='JPEG')
    assert_rejected(face_result(FaceJob(reference_mode='existing_reference',captures=[encoded(stream.getvalue())])),'no_face')

def test_actual_declared_two_face_composite_is_rejected_as_multiple_faces():
    raw=(ROOT/'verification/docker-native-journey-20261013/fixtures/P2.jpg').read_bytes()
    assert_rejected(face_result(FaceJob(reference_mode='existing_reference',captures=[encoded(raw)])),'multiple_faces')

@pytest.mark.parametrize('raw,mime',[(b'\xff\xd8\xff\xe0broken-jpeg','image/jpeg'),(b'not an image','image/jpeg')])
def test_only_typed_decode_failure_becomes_invalid_image(raw,mime):
    assert_rejected(face_result(FaceJob(reference_mode='existing_reference',captures=[encoded(raw,mime)])),'invalid_image')

def test_declared_mime_mismatch_is_rejected_as_invalid_image():
    c=capture();c['mime']='image/png'
    assert_rejected(face_result(FaceJob(reference_mode='existing_reference',captures=[c])),'invalid_image')

def test_existing_point25_quality_gate_has_a_bounded_reason_without_new_thresholds(monkeypatch):
    # This controlled branch covers the gate exactly; the actual detector/model
    # cases above are separate, and no numerical operating approval is inferred.
    monkeypatch.setattr(pipeline,'process_photo_bytes',lambda *args:SimpleNamespace(faces=[SimpleNamespace(quality_score=.2499)]))
    assert_rejected(face_result(FaceJob(reference_mode='existing_reference',captures=[capture()])),'quality_low')

def test_model_failure_is_not_mislabeled_as_capture_quality(monkeypatch):
    def failed(*args):raise RuntimeError('controlled model fault')
    monkeypatch.setattr(pipeline,'process_photo_bytes',failed)
    with pytest.raises(RuntimeError,match='controlled model fault'):
        face_result(FaceJob(reference_mode='existing_reference',captures=[capture()]))

def test_capture_digest_and_reference_mismatch_are_not_quality_rejections():
    c=capture();c['sha256']='0'*64
    with pytest.raises(HTTPException,match='image_digest_invalid'):
        face_result(FaceJob(reference_mode='existing_reference',captures=[c]))
    old=registered();wrong=capture(0,ROOT/'verification/docker-native-journey-20261013/fixtures/eric-selfie-0.jpg')
    result=face_result(FaceJob(reference_mode='existing_reference',captures=[wrong],
        reference_base64=old['template_base64'],reference_digest=old['template_sha256']))
    assert result['identity_verified'] is False and result['reference_match'] is False
    assert 'capture_rejection' not in result

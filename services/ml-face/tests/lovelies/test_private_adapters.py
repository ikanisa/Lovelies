from __future__ import annotations
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import uuid

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageEnhance
from lovelies_ml_face.app import app, face_result, photo_result, FaceJob, PhotoJob, MODEL, pipeline

ASSETS = Path(__file__).parents[4] / 'shared/assets'

def capture(index=0, path=None):
    path = path or ASSETS / 'person02.jpg'
    with Image.open(path) as image:
        image = ImageEnhance.Brightness(image.convert('RGB')).enhance(1+index*0.025)
        stream=io.BytesIO();image.save(stream,format='JPEG',quality=93-index)
    raw=stream.getvalue()
    return {'mime':'image/jpeg','sha256':hashlib.sha256(raw).hexdigest(),'bytes_base64':base64.b64encode(raw).decode()}

def registered():
    return face_result(FaceJob(reference_mode='first_registration',captures=[capture(i) for i in range(3)]))

def test_copied_real_artifacts_create_a_private_reference_and_match_it_without_liveness():
    assert not pipeline.using_deterministic_simulator
    result=registered()
    assert result['enrollment_verified'] is True
    assert result['identity_verified'] is True
    raw=base64.b64decode(result['template_base64'],validate=True)
    assert hashlib.sha256(raw).hexdigest()==result['template_sha256']
    template=json.loads(raw)
    assert template['model_id']==MODEL and len(template['embeddings'])==3
    assert all(len(v)==128 for v in template['embeddings'])
    matched=face_result(FaceJob(reference_mode='existing_reference',captures=[capture(1)],
        reference_base64=result['template_base64'],reference_digest=result['template_sha256']))
    assert matched['identity_verified'] is True and matched['reference_match'] is True
    assert not any(k.startswith(('pad_','injection_')) for k in result)

def test_actual_no_face_capture_cannot_enroll_or_authenticate():
    image=Image.new('RGB',(256,256),'white');data=io.BytesIO();image.save(data,format='JPEG')
    raw=data.getvalue();c={'mime':'image/jpeg','bytes_base64':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()}
    result=face_result(FaceJob(reference_mode='existing_reference',captures=[c]))
    assert result['identity_verified'] is False

def test_reference_digest_and_capture_manifest_must_match_actual_bytes():
    result=registered()
    with pytest.raises(Exception,match='registered_reference_invalid'):
        face_result(FaceJob(reference_mode='existing_reference',captures=[capture(1)],
            reference_base64=result['template_base64'],reference_digest='a'*64))
    bad=capture();bad['sha256']='0'*64
    with pytest.raises(Exception,match='image_digest_invalid'):
        face_result(FaceJob(reference_mode='existing_reference',captures=[bad]))

def test_actual_photo_matching_proposes_only_bound_profiles_and_returns_normalized_reduced_preview():
    result=registered();account=str(uuid.uuid4());profile=str(uuid.uuid4())
    photo=photo_result(PhotoJob(asset_id=str(uuid.uuid4()),source=capture(1),profiles=[{
        'account_id':account,'profile_id':profile,'revision':'local-model-reference','model_id':MODEL,
        'template_base64':result['template_base64'],'template_digest':result['template_sha256']}]))
    assert photo['matches']==[{'recipient_id':account,'profile_id':profile,'profile_version':'local-model-reference','model_version':MODEL}]
    with Image.open(io.BytesIO(base64.b64decode(photo['preview']['bytes_base64']))) as preview:
        assert preview.format=='JPEG' and preview.width==photo['preview']['width']
        assert max(preview.size)<=1600 and not preview.getexif()
    assert not any(k in photo for k in ['grants','access_token','embeddings','faces'])

def test_boundaries_hide_raw_validation_input_and_public_face_directory_is_absent():
    with TestClient(app,raise_server_exceptions=False,headers={'Authorization':'Bearer '+os.environ['ML_INFERENCE_SECRET']}) as client:
        ready=client.get('/ready');assert ready.status_code==200 and ready.json()['liveness_required'] is False
        response=client.post('/internal/face',json={'raw_vector':'SECRET-TEST-VECTOR'})
        assert response.status_code==400 and 'SECRET-TEST-VECTOR' not in response.text
        assert response.headers['cache-control']=='no-store'
        assert client.get('/openapi.json').status_code==404
        assert client.get('/faces').status_code==404

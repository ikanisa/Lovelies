"""Private inference adapter. Matching creates proposals, never photo access.

Authentication is registered-face comparison under owner policy; no liveness,
PAD, blink, movement, or camera-sensor attestation is implemented or required.
"""
from __future__ import annotations
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool
from pictured_ml_face.http_boundary import MlHttpBoundary
from .service_auth import authenticated_transport
from pictured_ml_face.models import CandidateEmbedding, FaceEmbedding, MatchDecision, MatchRequest, PhotoProcessRequest
from pictured_ml_face.pipeline import FacePipeline
from pictured_ml_face.image_contract import ImageValidationError

MAX_IMAGE = 20 * 1024 * 1024
MODEL = 'opencv-yunet-sface-2021dec-v1'
TEMPLATE_PROTOCOL = 'lovelies-face-template-v1'
pipeline = FacePipeline(os.environ.get('MODEL_MANIFEST_PATH', str(Path(__file__).parents[2] / 'models/model-manifest.json')))
if pipeline.using_deterministic_simulator or pipeline.manifest.active_model_version != MODEL:
    raise RuntimeError('Lovelies requires the real registered YuNet/SFace model')
AUTH_DISTANCE = float(os.environ.get('FACE_AUTH_MAX_COSINE_DISTANCE', '0.35'))
if not math.isfinite(AUTH_DISTANCE) or not 0 < AUTH_DISTANCE <= 0.42:
    raise RuntimeError('Invalid registered-face comparison threshold')

class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

class Capture(Strict):
    bytes_base64: str = Field(max_length=((MAX_IMAGE + 2) // 3) * 4)
    mime: Literal['image/jpeg','image/png','image/webp']
    sha256: str = Field(pattern=r'^[0-9a-f]{64}$')

class Template(Strict):
    protocol: Literal['lovelies-face-template-v1']
    model_id: Literal['opencv-yunet-sface-2021dec-v1']
    embeddings: list[FaceEmbedding] = Field(min_length=3, max_length=3)

class Profile(Strict):
    account_id: str = Field(min_length=36, max_length=36)
    profile_id: str = Field(min_length=36, max_length=36)
    revision: str = Field(min_length=1, max_length=128)
    model_id: Literal['opencv-yunet-sface-2021dec-v1']
    template_base64: str = Field(max_length=87384)
    template_digest: str = Field(pattern=r'^[0-9a-f]{64}$')

class PhotoJob(Strict):
    asset_id: str = Field(min_length=36, max_length=36)
    source: Capture
    profiles: list[Profile] = Field(max_length=1000)

class FaceJob(Strict):
    reference_mode: Literal['first_registration','existing_reference','replace_reference']
    captures: list[Capture] = Field(min_length=1, max_length=3)
    reference_base64: str | None = Field(default=None, max_length=87384)
    reference_digest: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')


def bytes_for(capture: Capture) -> bytearray:
    try:
        data = bytearray(base64.b64decode(capture.bytes_base64, validate=True))
    except (ValueError, TypeError):
        raise HTTPException(400, 'image_encoding_invalid') from None
    if not data or len(data) > MAX_IMAGE or hashlib.sha256(data).hexdigest() != capture.sha256:
        data[:] = bytes(len(data))
        raise HTTPException(400, 'image_digest_invalid')
    return data


def template_for(encoded: str, expected: str) -> Template:
    data = bytearray()
    try:
        data = bytearray(base64.b64decode(encoded, validate=True))
        if not data or len(data) > 65536 or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError()
        return Template.model_validate_json(bytes(data))
    except (ValueError, TypeError):
        raise HTTPException(409, 'registered_reference_invalid') from None
    finally:
        data[:] = bytes(len(data))


def photo_result(job: PhotoJob) -> dict:
    raw = bytes_for(job.source)
    image = None
    try:
        result = pipeline.process_photo_bytes(PhotoProcessRequest(event_id='private-photo', asset_id=job.asset_id,
            object_key='private-source', content_type=job.source.mime), bytes(raw))
        candidates = []
        by_profile = {}
        if len({p.account_id for p in job.profiles}) != len(job.profiles):
            raise HTTPException(400, 'duplicate_profile')
        for profile in job.profiles:
            reference = template_for(profile.template_base64, profile.template_digest)
            by_profile[profile.profile_id] = profile
            candidates.extend(CandidateEmbedding(user_id=profile.account_id, face_profile_id=profile.profile_id,
                embedding=vector) for vector in reference.embeddings)
        matched = {}
        for index, face in enumerate(result.faces):
            decision = pipeline.match_face(MatchRequest(event_id='private-photo', detected_face_id=str(index),
                embedding=face.embedding, candidates=candidates))
            # The copied transport deliberately downgrades numerical matches to
            # review proposals. Use its separate numerical decision to select
            # candidates; the Worker still requires contributor review and exact
            # recipient acceptance before it creates any media grant.
            if decision.numeric_decision == MatchDecision.AUTO_MATCHED and decision.face_profile_id in by_profile:
                profile = by_profile[decision.face_profile_id]
                matched[profile.account_id] = {'recipient_id': profile.account_id, 'profile_id': profile.profile_id,
                    'profile_version': profile.revision, 'model_version': profile.model_id}
        # Normalize orientation and strip EXIF/ICC/GPS. Only the protected reduced
        # rendition returns to the Worker; originals remain in private quarantine.
        with Image.open(io.BytesIO(raw)) as source:
            image = ImageOps.exif_transpose(source).convert('RGB')
            image.thumbnail((1600,1600), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.save(output, format='JPEG', quality=86, optimize=True)
            preview = output.getvalue()
        if len(preview) > 4 * 1024 * 1024:
            raise HTTPException(413, 'preview_too_large')
        return {'model_version': MODEL, 'matches': list(matched.values()),
            'preview': {'bytes_base64': base64.b64encode(preview).decode(), 'content_type':'image/jpeg',
                'width': image.width, 'height': image.height}}
    finally:
        raw[:] = bytes(len(raw))
        if image is not None:
            image.close()


def face_result(job: FaceJob) -> dict:
    expected = 3 if job.reference_mode in ('first_registration', 'replace_reference') else 1
    if len(job.captures) != expected or len({c.sha256 for c in job.captures}) != expected:
        raise HTTPException(400, 'capture_count_invalid')
    vectors = []
    try:
        for index, capture in enumerate(job.captures):
            raw = bytes_for(capture)
            try:
                try:
                    result = pipeline.process_photo_bytes(PhotoProcessRequest(event_id='private-face',
                        asset_id='private-capture', object_key='private-capture', content_type=capture.mime), bytes(raw))
                except ImageValidationError:
                    return {'identity_verified':False, 'model_id':MODEL,
                        'capture_rejection':{'code':'invalid_image', 'capture_index':index}}
            finally:
                raw[:] = bytes(len(raw))
            reason = 'no_face' if not result.faces else 'multiple_faces' if len(result.faces) != 1 else \
                'quality_low' if result.faces[0].quality_score < 0.25 else None
            if reason:
                # This private reason is bounded and carries no score, vector,
                # reference or identity claim. The existing quality gate is unchanged.
                return {'identity_verified':False, 'model_id':MODEL,
                    'capture_rejection':{'code':reason, 'capture_index':index}}
            vectors.append(np.array(result.faces[0].embedding, dtype=np.float64))
        if job.reference_mode in ('first_registration', 'replace_reference'):
            # All enrolled vectors must describe the same face; captions/pose
            # labels are profile guidance and never treated as liveness evidence.
            same = all(float(1-np.clip(np.dot(a,b),-1,1)) <= AUTH_DISTANCE
                for i,a in enumerate(vectors) for b in vectors[i+1:])
            if not same:
                return {'identity_verified':False, 'model_id':MODEL}
            replacing = job.reference_mode == 'replace_reference'
            if replacing:
                if job.reference_base64 is None or job.reference_digest is None:
                    raise HTTPException(400, 'registered_reference_required')
                reference = template_for(job.reference_base64, job.reference_digest)
                matched = all(min(float(1-np.clip(np.dot(a,np.array(v,dtype=np.float64)),-1,1))
                    for v in reference.embeddings) <= AUTH_DISTANCE for a in vectors)
                if not matched:
                    return {'identity_verified':False, 'reference_match':False, 'model_id':MODEL}
            template = Template(protocol=TEMPLATE_PROTOCOL, model_id=MODEL,
                embeddings=[v.tolist() for v in vectors])
            encoded = json.dumps(template.model_dump(), sort_keys=True, separators=(',',':')).encode()
            return {'identity_verified':True, 'enrollment_verified':True, 'model_id':MODEL,
                'template_sha256':hashlib.sha256(encoded).hexdigest(), 'template_base64':base64.b64encode(encoded).decode(),
                **({'reference_match':True} if replacing else {})}
        if job.reference_base64 is None or job.reference_digest is None:
            raise HTTPException(400, 'registered_reference_required')
        reference = template_for(job.reference_base64, job.reference_digest)
        same = min(float(1-np.clip(np.dot(vectors[0],np.array(v,dtype=np.float64)),-1,1))
            for v in reference.embeddings) <= AUTH_DISTANCE
        return {'identity_verified':same, 'reference_match':same, 'model_id':MODEL}
    finally:
        for vector in vectors:
            vector.fill(0)


http_app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
@http_app.exception_handler(RequestValidationError)
async def invalid_request(_request: Request, _error: RequestValidationError):
    return JSONResponse({'error':{'code':'invalid_input'}},status_code=400)
@http_app.exception_handler(Exception)
async def failed_request(_request: Request, _error: Exception):
    # Never echo submitted images/vectors or framework exception messages.
    return JSONResponse({'error':{'code':'inference_failed'}},status_code=503)
@http_app.get('/ready')
def ready():
    return {'service':'lovelies-ml-face','model_version':MODEL,'model_artifacts':pipeline.artifact_integrity,
        'matching_evaluation':pipeline.evaluation_status,'authentication':'registered_face_comparison','liveness_required':False}
@http_app.post('/internal/photo')
async def process(job: PhotoJob):
    return await run_in_threadpool(photo_result, job)
@http_app.post('/internal/face')
async def verify(job: FaceJob):
    return await run_in_threadpool(face_result, job)

app = MlHttpBoundary(http_app, max_requests=2, body_timeout_seconds=30)
app.limits.update({'/internal/photo':40*1024*1024, '/internal/face':12*1024*1024})

app = authenticated_transport(app)

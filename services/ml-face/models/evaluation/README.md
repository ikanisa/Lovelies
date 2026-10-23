# ML evaluation reports

Store consented subject material and production reports outside source control.
Only explicitly scrubbed aggregate examples belong in this folder. Historical
copied references and an example report are not model approval.

Current Lovelies uses backend-verified three-capture enrollment, fresh registered-
reference sign-in and consented photo matching. Both authentication and matching
need representative evaluation, threshold review, error/fairness analysis,
operating monitoring and rollback qualification. Liveness/PAD, blink, movement
challenges and camera-injection qualification are outside the owner's app scope.
Ordinary pose guidance is not liveness evidence.

The implemented matching evaluator can be invoked from services/ml-face:

```sh
PYTHONPATH=src .venv/bin/python -m pictured_ml_face.evaluate_matching \
  --input /absolute/private/consented-dataset.json \
  --output /absolute/private/aggregate-matching-report.json \
  --calibration /absolute/private/calibration-dataset.json
```

Use the evaluator's documented strict schema and the exact model, dataset and
threshold identities; separate calibration from held-out evaluation. The bundled
synthetic example checks code contracts only. A passing matching report does not
qualify face-authentication thresholds or enroll/sign-in operating behavior.
Those representative results and their independent review remain required.

For strict production startup, FacePipeline verifies the selected model artifacts,
aggregate report and its sidecar digest, dataset/calibration/change-control, bias,
policy, monitoring, rollback and operation evidence. Configure
ML_EVALUATION_REPORT_PATH to the externally reviewed aggregate. The older
pnpm ml:evaluation:prepare and ml:evaluation:clean commands are absent in this
workspace and must not be cited as executed tooling.

ML_DEPLOYMENT_MODE=monitored_pilot verifies artifacts while explicitly reporting
pending representative evaluation. It is useful for bounded local engineering
checks and is not proof of strict production approval. The final HTTPS deployment
must use the reviewed strict mode, exact artifacts/report and authenticated private
transport. The 23 local private-adapter/service-auth tests do not close A05 or the
model operating-acceptance gate.

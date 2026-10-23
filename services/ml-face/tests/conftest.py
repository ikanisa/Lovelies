from __future__ import annotations

import os


# Unit fixtures intentionally use deterministic, non-image byte strings. This flag
# is rejected by FacePipeline whenever the process declares a production runtime.
os.environ.setdefault("ML_USE_DETERMINISTIC_SIMULATOR", "true")

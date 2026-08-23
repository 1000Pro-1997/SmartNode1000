from .nodes import (
    NODE_CLASS_MAPPINGS as _LORA_NODES,
    NODE_DISPLAY_NAME_MAPPINGS as _LORA_NAMES,
)
from .nodes_resolution import (
    NODE_CLASS_MAPPINGS as _RES_NODES,
    NODE_DISPLAY_NAME_MAPPINGS as _RES_NAMES,
)
from .nodes_checklist import (
    NODE_CLASS_MAPPINGS as _CHK_NODES,
    NODE_DISPLAY_NAME_MAPPINGS as _CHK_NAMES,
)
from . import api  # noqa: F401  API 라우트 등록
from . import civitai  # noqa: F401  Civitai 라우트 등록(api 의 헬퍼를 쓴다)
from . import civitai_updates  # noqa: F401  업데이트 확인 라우트(civitai 의 헬퍼를 쓴다)
from . import lora_resolve  # noqa: F401  로라 다시 잇기 라우트(이름 비교는 civitai_updates 것을 쓴다)
from . import models  # noqa: F401  체크포인트 등 모델 관리 라우트
from . import workflows  # noqa: F401  워크플로우 관리 라우트
from . import workflow_store  # noqa: F401  워크플로우 곁다리 저장소
from . import huggingface  # noqa: F401  허깅페이스에서 모델 찾기
from . import imports  # noqa: F401  브라우저로 받은 파일 가져오기

# 노드가 늘어나면 여기에 모아서 등록한다.
NODE_CLASS_MAPPINGS = {**_LORA_NODES, **_RES_NODES, **_CHK_NODES}
NODE_DISPLAY_NAME_MAPPINGS = {**_LORA_NAMES, **_RES_NAMES, **_CHK_NAMES}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

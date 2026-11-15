"""SN1000 그룹 토글 노드."""


class SN1000GroupToggle:
    """캔버스의 그룹을 통째로 바이패스하거나 끄는 체크리스트.

    실제 일은 전부 브라우저가 한다(web/fla_group_toggle.js). 노드의 실행
    모드(정상·바이패스·끄기)는 프론트엔드가 들고 있고, 프롬프트를 만들 때
    이미 반영돼 서버로 오므로 파이썬이 할 일이 없다. 여기서는 항목 목록을
    워크플로에 함께 저장할 칸(items_data)만 만든다.

    출력이 없고 OUTPUT_NODE 도 아니라 실행 대상에 들지 않는다. 프롬프트에
    실려 오더라도 검증·실행 어느 쪽도 이 노드를 건드리지 않는다.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "items_data": ("STRING", {
                    "default": "[]",
                    "multiline": False,
                    "tooltip": "Toggle items as JSON. Managed by the UI.",
                }),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "SN1000"
    DESCRIPTION = (
        "Bypasses or mutes whole canvas groups from one checklist. "
        "Pick groups by name or colour; items in the same toggle group act like radio buttons."
    )

    def noop(self, items_data):
        return ()


NODE_CLASS_MAPPINGS = {
    "SN1000GroupToggle": SN1000GroupToggle,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SN1000GroupToggle": "SN1000 Group Toggle",
}

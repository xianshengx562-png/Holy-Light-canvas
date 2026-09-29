"""AIFISHER 画布输入节点。

把工作流里想让画布调整的输入，换成这里的一个输入节点，AIFISHER 导入时就按节点上
写的名称、分组和顺序，直接生成画布上的参数，不必再去参数配置页逐个勾选。

设计上刻意只做两件事：
1. 原样输出一个值，接到原来的输入上，工作流在 ComfyUI 里照常能跑；
2. 把画布需要的展示信息（名称、分组、顺序、是否折进高级）写在节点自己身上。

因此这些节点在 ComfyUI 里是普通的取值节点，不依赖 AIFISHER 也能用；
AIFISHER 只是多读了节点上的那几个说明字段。
"""

MANIFEST_NAME = "AIFISHER-COMFYUI 画布输入"
SCHEMA_VERSION = 1

CATEGORY = "AIFISHER"
_GROUP_DEFAULT = "基础参数"


def _presentation(extra=None):
    """每个输入节点都带同一组画布展示字段，排在被取的值后面。"""
    fields = {
        "画布名称": ("STRING", {"default": "", "multiline": False}),
        "画布分组": ("STRING", {"default": _GROUP_DEFAULT, "multiline": False}),
        "画布顺序": ("INT", {"default": 0, "min": 0, "max": 999, "step": 1}),
        "折进高级": ("BOOLEAN", {"default": False}),
    }
    if extra:
        fields.update(extra)
    return fields


class _CanvasInput:
    """取值节点的共同部分：原样返回第一个输入，其余字段只给 AIFISHER 读。"""

    FUNCTION = "resolve"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {**cls.VALUE_INPUT, **_presentation(getattr(cls, "EXTRA_INPUT", None))}}

    def resolve(self, **kwargs):
        (name,) = self.VALUE_INPUT.keys()
        return (kwargs.get(name),)


class CanvasTextInput(_CanvasInput):
    """提示词或任意文本。"""

    VALUE_INPUT = {"文本": ("STRING", {"default": "", "multiline": True})}
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)


class CanvasNumberInput(_CanvasInput):
    """小数参数，例如 CFG、降噪强度。"""

    VALUE_INPUT = {"数值": ("FLOAT", {"default": 1.0, "min": -1.0e9, "max": 1.0e9, "step": 0.01})}
    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("数值",)


class CanvasIntegerInput(_CanvasInput):
    """整数参数，例如步数、宽高。"""

    VALUE_INPUT = {"整数": ("INT", {"default": 0, "min": -1.0e9, "max": 1.0e9, "step": 1})}
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("整数",)


class CanvasSeedInput(_CanvasInput):
    """种子。画布默认按随机处理，可在节点参数里改成固定或递增。"""

    VALUE_INPUT = {"种子": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF})}
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("种子",)


class CanvasSwitchInput(_CanvasInput):
    """开关参数。"""

    VALUE_INPUT = {"开关": ("BOOLEAN", {"default": True})}
    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("开关",)


class CanvasImageInput(_CanvasInput):
    """画布连进来的图片。接一个 LoadImage 作为在 ComfyUI 里单独运行时的占位图。"""

    VALUE_INPUT = {"图片": ("IMAGE",)}
    EXTRA_INPUT = {"允许多张": ("BOOLEAN", {"default": False})}
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图片",)


class CanvasMaskInput(_CanvasInput):
    """画布连进来的蒙版。"""

    VALUE_INPUT = {"蒙版": ("MASK",)}
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("蒙版",)


NODE_CLASS_MAPPINGS = {
    "AIFisherCanvasText": CanvasTextInput,
    "AIFisherCanvasNumber": CanvasNumberInput,
    "AIFisherCanvasInteger": CanvasIntegerInput,
    "AIFisherCanvasSeed": CanvasSeedInput,
    "AIFisherCanvasSwitch": CanvasSwitchInput,
    "AIFisherCanvasImage": CanvasImageInput,
    "AIFisherCanvasMask": CanvasMaskInput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIFisherCanvasText": "画布文本输入",
    "AIFisherCanvasNumber": "画布小数输入",
    "AIFisherCanvasInteger": "画布整数输入",
    "AIFisherCanvasSeed": "画布种子输入",
    "AIFisherCanvasSwitch": "画布开关输入",
    "AIFisherCanvasImage": "画布图片输入",
    "AIFisherCanvasMask": "画布蒙版输入",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

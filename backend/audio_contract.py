"""双引擎音频契约（Python 侧）。

与 frontend/audio-contract.js 保持同一份“逐句音频范围”逻辑：
桌面端 _unit_audio 与移动/网页端 engine.js 用完全相同的规则计算
start_ms/end_ms，避免两个平台出现“一句播完不收、直接播到下一句”的分叉。
tests/audio_contract_check.py 对两端做回归对比，改这里必须同步改 JS。
"""


def resolve_unit_range(start, end, text, next_start):
    """由单元自身时间戳 + 下一句起点，算出最终播放区间。

    - end > start：直接用给定区间
    - 否则：下一句起点可用 → 截到下一句；仍没有 → 按词数估算时长，
      保证逐句播放永远有截断（而不是整段播到底）。
    """
    start = int(start or 0)
    end = int(end or 0)
    if not (end > start):
        if next_start and next_start > start:
            end = int(next_start)
        else:
            end = start + max(1500, len(text.split()) * 420)
    return start, end
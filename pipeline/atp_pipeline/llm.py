"""One way to talk to any model, so pipeline steps never import a vendor SDK.

Pick a model with a "provider:model" string, e.g. "deepseek:deepseek-v4-pro"
or "anthropic:claude-opus-5-5". To add a vendor with an OpenAI-compatible API,
add one line to OPENAI_COMPATIBLE.

Each session keeps the conversation in its vendor's own message format. Turning
it into a common format and back would drop things the vendors require us to
send back unchanged (Claude's thinking blocks, DeepSeek's reasoning_content).
"""

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Literal

import anthropic
import openai

from . import config

Stop = Literal["end", "tool_calls", "max_tokens", "refusal", "other"]


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict  # JSON Schema of the arguments


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict | None  # None if the model sent arguments that aren't valid JSON
    raw_arguments: str = ""


@dataclass
class ToolResult:
    call_id: str
    content: str
    is_error: bool = False


@dataclass
class Turn:
    """One model response, in the same shape for every vendor."""

    text: str
    tool_calls: list[ToolCall]
    stop: Stop
    stop_detail: str | None = None  # vendor's raw reason, for logs and errors
    input_tokens: int = 0
    output_tokens: int = 0


class ChatSession(ABC):
    @abstractmethod
    def add_user(self, text: str) -> None: ...

    @abstractmethod
    def add_tool_results(self, results: list[ToolResult]) -> None: ...

    @abstractmethod
    def step(self) -> Turn:
        """Send the conversation so far and record the model's reply."""


def open_session(model: str, system: str, tools: list[Tool], effort: str = "high") -> ChatSession:
    """effort: low | medium | high | max, mapped to each vendor's setting."""
    provider, _, model_id = model.partition(":")
    if provider == "anthropic":
        return AnthropicSession(model_id, system, tools, effort)
    if provider in OPENAI_COMPATIBLE:
        return OpenAICompatibleSession(OPENAI_COMPATIBLE[provider], model_id, system, tools, effort)
    raise ValueError(f"unknown provider {provider!r} in model {model!r}")


# ---------------------------------------------------------------- Anthropic


class AnthropicSession(ChatSession):
    STOPS = {"end_turn": "end", "stop_sequence": "end", "tool_use": "tool_calls",
             "max_tokens": "max_tokens", "refusal": "refusal"}

    def __init__(self, model: str, system: str, tools: list[Tool], effort: str):
        self.client = anthropic.Anthropic(api_key=config.require("ANTHROPIC_API_KEY"))
        self.model = model
        self.system = system
        self.effort = effort
        self.tools = [
            {"name": t.name, "description": t.description, "input_schema": t.parameters, "strict": True}
            for t in tools
        ]
        self.messages: list = []

    def add_user(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})

    def add_tool_results(self, results: list[ToolResult]) -> None:
        self.messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": r.call_id, "content": r.content, "is_error": r.is_error}
            for r in results
        ]})

    def step(self) -> Turn:
        turn = Turn(text="", tool_calls=[], stop="other")
        while True:
            # Streamed because the SDK refuses non-streaming calls this large.
            with self.client.beta.messages.stream(
                model=self.model,
                max_tokens=32000,
                system=self.system,
                tools=self.tools,
                messages=self.messages,
                output_config={"effort": self.effort},
                cache_control={"type": "ephemeral"},
                # On a safety decline, rerun on a fallback model instead of stopping.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            ) as stream:
                response = stream.get_final_message()
            # Keep the full content (thinking blocks included); Claude needs it back.
            self.messages.append({"role": "assistant", "content": response.content})
            u = response.usage
            turn.input_tokens += (u.input_tokens or 0) + (u.cache_read_input_tokens or 0) + (u.cache_creation_input_tokens or 0)
            turn.output_tokens += u.output_tokens or 0
            if response.stop_reason != "pause_turn":
                break

        turn.text = "".join(b.text for b in response.content if b.type == "text")
        turn.tool_calls = [
            ToolCall(id=b.id, name=b.name, arguments=b.input, raw_arguments=json.dumps(b.input))
            for b in response.content if b.type == "tool_use"
        ]
        turn.stop = self.STOPS.get(response.stop_reason, "other")
        turn.stop_detail = str(response.stop_details) if response.stop_reason == "refusal" else response.stop_reason
        return turn


# -------------------------------------------------------- OpenAI-compatible


@dataclass
class OpenAICompatibleProvider:
    key_env: str
    base_url: str | None = None  # None = OpenAI itself
    # Maps our effort levels to the vendor's reasoning_effort values; empty = don't send it.
    efforts: dict[str, str] = field(default_factory=dict)


OPENAI_COMPATIBLE = {
    "deepseek": OpenAICompatibleProvider(
        key_env="DEEPSEEK_API_KEY",
        base_url="https://api.deepseek.com",
        efforts={"low": "low", "medium": "high", "high": "high", "max": "max"},
    ),
    "openai": OpenAICompatibleProvider(
        key_env="OPENAI_API_KEY",
        efforts={"low": "low", "medium": "medium", "high": "high", "max": "high"},
    ),
}


class OpenAICompatibleSession(ChatSession):
    STOPS = {"stop": "end", "tool_calls": "tool_calls", "length": "max_tokens", "content_filter": "refusal"}

    def __init__(self, provider: OpenAICompatibleProvider, model: str, system: str, tools: list[Tool], effort: str):
        self.client = openai.OpenAI(api_key=config.require(provider.key_env), base_url=provider.base_url)
        self.model = model
        self.reasoning_effort = provider.efforts.get(effort)
        self.tools = [
            {"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}
            for t in tools
        ]
        self.messages: list = [{"role": "system", "content": system}]

    def add_user(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})

    def add_tool_results(self, results: list[ToolResult]) -> None:
        # This format has no error flag, so errors are marked in the text.
        for r in results:
            content = f"ERROR: {r.content}" if r.is_error else r.content
            self.messages.append({"role": "tool", "tool_call_id": r.call_id, "content": content})

    def step(self) -> Turn:
        kwargs = {"reasoning_effort": self.reasoning_effort} if self.reasoning_effort else {}
        response = self.client.chat.completions.create(
            model=self.model,
            messages=self.messages,
            tools=self.tools,
            max_tokens=32000,
            **kwargs,
        )
        choice = response.choices[0]
        msg = choice.message

        assistant = {"role": "assistant", "content": msg.content or ""}
        if msg.tool_calls:
            assistant["tool_calls"] = [
                {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
                for c in msg.tool_calls
            ]
        # DeepSeek returns 400 on the next request if a turn's reasoning isn't sent back.
        reasoning = getattr(msg, "reasoning_content", None) or (msg.model_extra or {}).get("reasoning_content")
        if reasoning:
            assistant["reasoning_content"] = reasoning
        self.messages.append(assistant)

        calls = []
        for c in msg.tool_calls or []:
            try:
                args = json.loads(c.function.arguments or "{}")
            except json.JSONDecodeError:
                args = None
            calls.append(ToolCall(id=c.id, name=c.function.name, arguments=args, raw_arguments=c.function.arguments or ""))

        stop = "tool_calls" if calls else self.STOPS.get(choice.finish_reason, "other")
        u = response.usage
        return Turn(
            text=msg.content or "",
            tool_calls=calls,
            stop=stop,
            stop_detail=choice.finish_reason,
            input_tokens=u.prompt_tokens if u else 0,
            output_tokens=u.completion_tokens if u else 0,
        )

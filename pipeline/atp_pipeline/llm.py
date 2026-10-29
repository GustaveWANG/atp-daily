"""One way to talk to any model, so pipeline steps never import a vendor SDK.

Pick a model with a "provider:model" string, e.g. "claude-code:sonnet",
"deepseek:deepseek-v4-pro" or "anthropic:claude-opus-5-5". To add a vendor with
an OpenAI-compatible API, add one line to OPENAI_COMPATIBLE.

"claude-code" runs the Claude Code CLI (`claude -p`), so calls use the Claude
subscription it is logged in to instead of an API key.

Each session keeps the conversation in its vendor's own message format. Turning
it into a common format and back would drop things the vendors require us to
send back unchanged (Claude's thinking blocks, DeepSeek's reasoning_content).
"""

import json
import os
import subprocess
import tempfile
import uuid
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
    if provider == "claude-code":
        return ClaudeCodeSession(model_id, system, tools, effort)
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
                max_tokens=config.MAX_OUTPUT_TOKENS,
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


# -------------------------------------------------------------- Claude Code


class ClaudeCodeError(RuntimeError):
    pass


class ClaudeCodeSession(ChatSession):
    """Talks to Claude through `claude -p`, billed to the logged-in subscription.

    The CLI runs its own tool loop and never hands tool calls back, so tools are
    not given to it. Instead every reply must be JSON (--json-schema) listing the
    tool calls the model wants; we run them here and send the results as the
    next message, resuming the same CLI session so earlier turns stay cached.
    """

    # Keys that would make the CLI bill an API account instead of the subscription.
    API_KEY_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")
    TIMEOUT_S = 20 * 60

    def __init__(self, model: str, system: str, tools: list[Tool], effort: str):
        self.model = model
        self.effort = effort
        self.tools = tools
        self.session_id = str(uuid.uuid4())
        self.started = False
        self.pending: list[str] = []
        # The CLI keys saved sessions by working directory, so --resume needs the
        # same one each call; an empty one also keeps project files out of context.
        self.workdir = tempfile.mkdtemp(prefix="claude-code-session-")
        self.system_file = os.path.join(self.workdir, "system.md")
        with open(self.system_file, "w") as f:
            f.write(system + "\n\n" + self._tool_protocol())
        self.schema = json.dumps(self._reply_schema())

    def _tool_protocol(self) -> str:
        if not self.tools:
            return ""
        listing = "\n".join(
            f"- {t.name}: {t.description}\n  arguments schema: {json.dumps(t.parameters)}" for t in self.tools
        )
        return (
            "# How to call tools\n\n"
            "You reply with JSON: `text` for anything you want to say, `tool_calls` for the tools to "
            "call now. To call a tool, add {\"name\": ..., \"arguments\": {...}} to `tool_calls`; you "
            "may call several at once. Their results come back in the next message. When something "
            "says to call a tool, it means adding it to `tool_calls`.\n\n"
            f"Tools:\n{listing}"
        )

    def _reply_schema(self) -> dict:
        calls = [
            {
                "type": "object",
                "properties": {"name": {"const": t.name}, "arguments": t.parameters},
                "required": ["name", "arguments"],
                "additionalProperties": False,
            }
            for t in self.tools
        ]
        # Every caller ends a session by a submit tool, so a turn with no tool call
        # is never useful. Requiring one stops the model from putting its answer
        # in `text` instead of submitting it.
        return {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "tool_calls": {"type": "array", "items": {"anyOf": calls}, "minItems": 1}
                if calls else {"type": "array", "maxItems": 0},
            },
            "required": ["text", "tool_calls"],
            "additionalProperties": False,
        }

    def add_user(self, text: str) -> None:
        self.pending.append(text)

    def add_tool_results(self, results: list[ToolResult]) -> None:
        self.pending.append("Tool results:\n\n" + json.dumps(
            [{"call_id": r.call_id, "is_error": r.is_error, "content": r.content} for r in results],
            ensure_ascii=False, indent=1,
        ))

    def step(self) -> Turn:
        prompt = "\n\n".join(self.pending)
        self.pending = []
        cmd = [
            "claude", "-p",
            "--output-format", "json",
            "--model", self.model,
            "--effort", self.effort,
            "--system-prompt-file", self.system_file,
            "--json-schema", self.schema,
            "--tools", "",
            "--strict-mcp-config",
            "--safe-mode",
            "--resume" if self.started else "--session-id", self.session_id,
        ]
        env = {k: v for k, v in os.environ.items() if k not in self.API_KEY_ENV}
        # The prompt goes in on stdin: tool results can be larger than one argument may be.
        proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True,
                              cwd=self.workdir, env=env, timeout=self.TIMEOUT_S)
        self.started = True
        try:
            data = json.loads(proc.stdout)
        except json.JSONDecodeError:
            raise ClaudeCodeError(f"claude exited {proc.returncode}: {(proc.stderr or proc.stdout)[:500]}")
        if data.get("is_error"):
            raise ClaudeCodeError(f"claude: {data.get('result') or data.get('subtype')}")

        reply = data.get("structured_output")
        if reply is None:
            try:
                reply = json.loads(data.get("result") or "")
            except json.JSONDecodeError:
                reply = {"text": data.get("result") or "", "tool_calls": []}
        u = data.get("usage") or {}
        calls = [
            ToolCall(id=f"call_{uuid.uuid4().hex[:8]}", name=c.get("name", ""),
                     arguments=c.get("arguments") if isinstance(c.get("arguments"), dict) else None,
                     raw_arguments=json.dumps(c.get("arguments")))
            for c in reply.get("tool_calls") or []
        ]
        return Turn(
            text=reply.get("text") or "",
            tool_calls=calls,
            stop="tool_calls" if calls else "end",
            stop_detail=data.get("stop_reason"),
            input_tokens=(u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
            + (u.get("cache_creation_input_tokens") or 0),
            output_tokens=u.get("output_tokens") or 0,
        )


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
            max_tokens=config.MAX_OUTPUT_TOKENS,
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

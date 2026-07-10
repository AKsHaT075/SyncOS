"use client";

import { useState } from "react";
import { Sparkles, Send, User, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { useUIStore } from "@/store/useUIStore";

// No agent backend wired yet — this is a canned reply so the panel is usable
// end-to-end until a real Copilot endpoint exists.
const PLACEHOLDER_REPLY =
  "I'm not connected to a live agent yet, but once wired up I'll be able to create tasks, summarize projects, and act on your workspace directly.";

export default function AIAssistantPanel() {
  const open = useUIStore((state) => state.aiPanelOpen);
  const setOpen = useUIStore((state) => state.setAIPanelOpen);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const sendMessage = () => {
    const text = input.trim();
    if (!text) return;
    setMessages((prev) => [
      ...prev,
      { id: Date.now(), role: "user", text },
      { id: Date.now() + 1, role: "assistant", text: PLACEHOLDER_REPLY },
    ]);
    setInput("");
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden border-zinc-200 bg-white transition-all duration-300",
        open ? "w-96 border-l" : "w-0 border-l-0"
      )}
      aria-hidden={!open}
    >
      <div className="flex w-96 shrink-0 items-center justify-between border-b border-zinc-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          
          <div>
            <p className="text-sm font-semibold text-zinc-900">Sync Copilot</p>
            <p className="text-xs text-zinc-500">Ask it to find, summarize, or create things for you.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close Sync Copilot"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="w-96 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-zinc-500">
            
            <p className="font-medium text-zinc-700">What can I do for you?</p>
            <p className="max-w-[220px] text-xs text-zinc-500">
              Try "Create a task for the design review" or "Summarize this week's projects"
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`flex items-start gap-2.5 ${message.role === "user" ? "flex-row-reverse" : ""}`}
            >
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-full ${
                  message.role === "user"
                    ? "bg-zinc-200 text-zinc-600"
                    : "bg-gradient-to-br from-fuchsia-500 via-violet-500 to-indigo-500 text-white"
                }`}
              >
                {message.role === "user" ? <User className="size-3.5" /> : <Sparkles className="size-3.5" />}
              </span>
              <div
                className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm ${
                  message.role === "user" ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700"
                }`}
              >
                {message.text}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="w-96 shrink-0 border-t border-zinc-100 p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Sync Copilot..."
            className="min-h-11 max-h-32 resize-none border-zinc-200 bg-zinc-50 focus-visible:ring-violet-300"
          />
          <button
            type="button"
            onClick={sendMessage}
            disabled={!input.trim()}
            aria-label="Send message"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-fuchsia-500 via-violet-500 to-indigo-500 text-white shadow-sm shadow-violet-500/30 transition-opacity disabled:opacity-40"
          >
            <Send className="size-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

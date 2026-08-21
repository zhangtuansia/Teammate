#!/usr/bin/env node

process.stdin.resume();
process.stdin.on("end", () => {
  const events = [
    { type: "thread.started", thread_id: "00000000-0000-4000-8000-000000000123" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { type: "reasoning", text: "private chain of thought" },
    },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "Visible final answer" },
    },
    { type: "turn.completed" },
  ];
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
});

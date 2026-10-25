# Relaydeck interface

The primary job is operating a team of locally or remotely hosted agent harnesses. The shell should feel like a workbench, with the agent roster always within reach and real process output central to the experience.

Palette: ink #17283b, paper #f5f7fb, blue #3c63db, mist #e7edf6, teal #24766b, terminal #182536. Typography: Segoe UI for controls and reading, Cascadia Code for terminal output. Use left-aligned content, generous main-panel spacing, compact roster rows, and a distinct dark terminal surface.

Layout:
```
Agent rail | Workspace title + connection status
           | Team overview / device topology
           | Selected terminal | Conversation
           | Recent activity
```

Review: a tiled statistics dashboard would obscure the work. Use a single connected team strip, an operational terminal, and a chronological conversation instead. The memorable element is the agent switchboard: each agent has its harness, device, task, and lifecycle in one row. Empty states explain how to connect real processes; no invented activity or placeholder agents.

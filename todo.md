# Agent Communication Tool

This should be a shell for agent harnesses: users run Hermes, OpenCode, or other existing harnesses/CLIs inside this application rather than launching each one separately. Multiple agents across multiple devices should be able to communicate with each other, regardless of which harness each agent uses.

- [x] Agents can announce their current task.
- [x] Agents can DM other agents using the MCP or CLI bridge.
- [x] Two message types: notice and message.
- [x] Append new messages to bridge tool responses, with an unanswered tag until the recipient replies with a message or notice. Optional terminal input delivery is available for compatible harnesses.
- [x] Notices do not require an answer.
- [x] Group rooms broadcast notices to all members.
- [x] A persistent host coordinates agents across device runners.
- [x] Forgejo/Gitea repository sync with status, fast-forward pull, and non-force push.
- [x] Humans can view terminals, reported tool activity, and message boards.
- [x] Humans can send messages and notices.
- [x] Council tool requests other agents' implementation recommendations.
- [x] All coordination tools can be enabled or disabled on the host.
- [x] Run installed harnesses/CLIs inside embedded terminals.
- [x] Shared communication across harnesses and devices.
- [x] Host and clients each support GUI and headless operation.

- [x] Bundled agent chat skill with automatic startup guidance for supported harnesses.
- [x] Edit startup commands and instructions for existing agents from host and client GUIs.
- [x] Agents discover rooms and read recent conversation through bridge tools.

Supported harnesses receive instructions to use the authenticated CLI bridge; MCP configuration is optional. Custom harnesses can use the provided skill manually. Arbitrary terminal programs do not provide a universal context-injection API. See README.md for setup, delivery behavior, and deployment verification limits.

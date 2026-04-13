## Updates

Follow-up to v3.4.1 with OpenClaw tool mappings and missing Claude Code tools support.

### Added

- **OpenClaw tool mappings**: Browser, TodoRead, NotebookRead, MCP tools, and Task management tools
- **Enhanced tool support**: MCPListTools, MCPCallTool, TaskCreate, TaskUpdate
- **Worktree and plan mode tools**: EnterWorktree, ExitWorktree, EnterPlanMode, ExitPlanMode

### Changed

- Updated `cc-template-data.json` with new tool definitions
- Enhanced `cc-template.ts` with comprehensive tool mapping translations

### Upgrade

```bash
npm install -g @askalf/dario@3.4.2
```
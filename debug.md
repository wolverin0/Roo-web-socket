[3:55:54 PM] Starting compilation in watch mode...

src/core/assistant-message/parse-assistant-message.ts:4:2 - error 
TS2305: Module '"."' has no exported member 'ToolUse'.

4  ToolUse,
   ~~~~~~~

src/core/diff/strategies/multi-search-replace.ts:5:10 - error TS2305: Module '"../../assistant-message"' has no exported member 'ToolUse'.

5 import { ToolUse } from "../../assistant-message"
           ~~~~~~~

src/core/diff/types.ts:6:10 - error TS2305: Module '"../assistant-message"' has no exported member 'ToolUse'.

6 import { ToolUse } from "../assistant-message"
           ~~~~~~~

src/extension.ts:83:11 - error TS2339: Property 'ipcService' does 
not exist on type 'ClineProvider'.

83  provider.ipcService = ipcService; // Assign IPC service to provider
             ~~~~~~~~~~

[3:55:58 PM] Found 4 errors. Watching for file changes.


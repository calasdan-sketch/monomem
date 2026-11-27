import { enableCompileCache } from "node:module";
if (!process.env.NO_CC) enableCompileCache();
await import("file:///C:/Users/danie/lab3/r8-speed/dist/src/mcp-stdio.js");

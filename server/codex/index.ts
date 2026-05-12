import { StdioCodexGateway } from "./stdioGateway";
import { WsCodexGateway } from "./wsGateway";

export type CodexGateway = StdioCodexGateway | WsCodexGateway;

export function createCodexGateway(): CodexGateway {
  return process.env.CODEX_WEB_GATEWAY === "ws" ? new WsCodexGateway() : new StdioCodexGateway();
}

export { StdioCodexGateway, WsCodexGateway };

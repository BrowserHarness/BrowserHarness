import { Box, Link, Typography } from "@mui/material";
import type { ReactNode } from "react";
import {
  parseMarkdown,
  type BlockNode,
  type InlineNode
} from "../runtime/markdown";

function inline(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "bold":
        return <strong key={index}>{node.text}</strong>;
      case "italic":
        return <em key={index}>{node.text}</em>;
      case "code":
        return (
          <Box
            key={index}
            component="code"
            sx={{ px: 0.5, borderRadius: 0.5, bgcolor: "action.hover", fontFamily: "monospace", fontSize: "0.85em" }}
          >
            {node.text}
          </Box>
        );
      case "link":
        return (
          <Link key={index} href={node.href} target="_blank" rel="noopener noreferrer">
            {node.text}
          </Link>
        );
      default:
        return <span key={index}>{node.text}</span>;
    }
  });
}

function block(node: BlockNode, index: number): ReactNode {
  switch (node.type) {
    case "heading":
      return (
        <Typography key={index} variant={node.level === 1 ? "subtitle1" : "subtitle2"} sx={{ fontWeight: 600, mt: 1 }}>
          {inline(node.inline)}
        </Typography>
      );
    case "list":
      return (
        <Box key={index} component={node.ordered ? "ol" : "ul"} sx={{ my: 0.5, pl: 2.5 }}>
          {node.items.map((item, i) => (
            <li key={i}>
              <Typography variant="body2" component="span">{inline(item)}</Typography>
            </li>
          ))}
        </Box>
      );
    case "code":
      return (
        <Box key={index} component="pre" sx={{ p: 1, my: 0.5, borderRadius: 1, bgcolor: "action.hover", overflow: "auto", fontSize: "0.8rem" }}>
          <code>{node.text}</code>
        </Box>
      );
    case "quote":
      return (
        <Typography key={index} variant="body2" sx={{ borderLeft: 3, borderColor: "divider", pl: 1, my: 0.5, color: "text.secondary" }}>
          {inline(node.inline)}
        </Typography>
      );
    default:
      return (
        <Typography key={index} variant="body2" sx={{ my: 0.5 }}>
          {inline(node.inline)}
        </Typography>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  return <>{parseMarkdown(text).map(block)}</>;
}

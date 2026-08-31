import type { MaterialTab } from "@/components/MaterialTabs";

export type ResearchWorkspace = {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  papers: MaterialTab[];
};

export type WorkspaceDocument =
  | { id: string; kind: "paper"; paper: MaterialTab }
  | { id: string; kind: "workspacePdf"; path: string; name: string }
  | { id: string; kind: "file"; path: string; name: string; extension: string };

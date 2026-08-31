"use client";
import { useEffect, useMemo, useState } from "react";
import type { AgentSkill } from "@/hooks/useAgentSkills";

type Props = {
  open: boolean;
  onClose: () => void;
  skills: AgentSkill[];
  activeIds: string[];
  onToggle: (id: string) => void;
  loading?: boolean;
};

export function SkillsDrawer({ open, onClose, skills, activeIds, onToggle, loading }: Props) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle))
      : skills.filter((skill) => showAll || activeIds.includes(skill.id) || skill.source === "personal");
    return [...matched].sort((a, b) => Number(activeIds.includes(b.id)) - Number(activeIds.includes(a.id)) || a.name.localeCompare(b.name));
  }, [skills, query, showAll, activeIds]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <button className="pr-drawer-backdrop" aria-label="Close skills" onClick={onClose} />
      <aside className="pr-capability-drawer" aria-label="Agent skills">
        <header>
          <div><small>AGENT CAPABILITIES</small><h2>Skills</h2></div>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <p className="pr-capability-note">Active skills are shared by Paper Reader and every research workspace.</p>
        <label className="pr-skill-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search installed skills…" /></label>
        <div className="pr-skill-list">
          {loading && <p className="pr-skill-empty">Finding installed skills…</p>}
          {!loading && visible.length === 0 && <p className="pr-skill-empty">No installed skill matches this search.</p>}
          {visible.map((skill) => {
            const active = activeIds.includes(skill.id);
            return (
              <button key={skill.id} type="button" className={active ? "active" : ""} onClick={() => onToggle(skill.id)}>
                <span>◆</span>
                <p><strong>{skill.name}</strong><small>{skill.description}</small><i>{skill.source}</i></p>
                <b>{active ? "ON" : "OFF"}</b>
              </button>
            );
          })}
          {!query && skills.length > visible.length && (
            <button type="button" className="pr-show-all-skills" onClick={() => setShowAll(true)}>
              <span>＋</span><p><strong>Show all installed skills</strong><small>{skills.length - visible.length} system and template skills are hidden</small></p><b>›</b>
            </button>
          )}
        </div>
        <footer>
          <span>🌐 Web is always available</span>
          <small>Skill installation will run in an isolated agent session.</small>
        </footer>
      </aside>
    </>
  );
}

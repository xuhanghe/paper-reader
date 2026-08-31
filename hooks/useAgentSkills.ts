"use client";
import { useCallback, useEffect, useState } from "react";

export type AgentSkill = {
  id: string;
  name: string;
  description: string;
  source: "project" | "personal" | "system";
};

export const ACTIVE_SKILLS_KEY = "paper-reader:active-skills";

function savedIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(ACTIVE_SKILLS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function useAgentSkills() {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>(savedIds);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/skills")
      .then((response) => response.json())
      .then((data) => { if (!cancelled) setSkills(Array.isArray(data.skills) ? data.skills : []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === ACTIVE_SKILLS_KEY) setActiveSkillIds(savedIds());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const setActive = useCallback((ids: string[]) => {
    const unique = [...new Set(ids)];
    setActiveSkillIds(unique);
    try { localStorage.setItem(ACTIVE_SKILLS_KEY, JSON.stringify(unique)); } catch {}
  }, []);

  const toggleSkill = useCallback((id: string) => {
    setActiveSkillIds((current) => {
      const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
      try { localStorage.setItem(ACTIVE_SKILLS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  return { skills, activeSkillIds, setActiveSkillIds: setActive, toggleSkill, loading };
}

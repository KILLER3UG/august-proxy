import { Card, CardContent } from "@/components/ui/card";
import type { Skill } from "./types";

/**
 * Grid of curated August skills with category, description, trigger, and
 * enable toggle display (toggle UI only; enable mutations live elsewhere).
 */
export function SkillsSection({ skills }: { skills: Skill[] }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold px-1">
            Skills
          </h3>
          <p className="px-1 text-xs text-muted-foreground">
            Curated skills that can be enabled for August.
          </p>
        </div>
      </div>
      {skills.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          No skills loaded.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {skills.map((skill) => (
            <Card key={skill.name} className="overflow-hidden rounded-2xl">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold font-mono truncate">
                        {skill.name}
                      </h3>
                      {skill.category && (
                        <span className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] text-muted-foreground">
                          {skill.category}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {skill.description}
                    </p>
                    {skill.trigger && (
                      <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                        trigger: {skill.trigger}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={
                      skill.enabled ? "Disable skill" : "Enable skill"
                    }
                    className={`relative w-9 h-5 rounded-full transition ${skill.enabled ? "bg-primary" : "bg-muted"}`}
                  >
                    <span
                      className={`absolute top-0.5 size-4 rounded-full bg-white transition ${skill.enabled ? "left-[18px]" : "left-0.5"}`}
                    />
                  </button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

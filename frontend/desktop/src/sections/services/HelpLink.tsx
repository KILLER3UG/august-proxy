import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";

/**
 * Opens provider docs or console pages next to OAuth/API credential fields
 * so users can find client IDs, tokens, and redirect URIs without leaving the form.
 */
export function HelpLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground hover:underline transition mt-0.5"
    >
      {children}
      <ExternalLink className="size-2.5" />
    </a>
  );
}

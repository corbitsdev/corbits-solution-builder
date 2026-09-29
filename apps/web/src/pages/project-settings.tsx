/**
 * One project's settings, opened from its card's menu (#246). Today one
 * section, slide decks: whether the workspace's design documents apply to
 * this project, and the project's own design documents, which always do.
 * The choice is written the moment it changes, the way Settings writes a
 * preference; the documents are artifacts on the project's own tenant.
 */
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@corbits/react-ui";
import { useEffect, useState } from "react";
import { api, ApiFailure, type ProjectSummary } from "../client.js";
import { Banner, Button } from "../components.jsx";
import type { ProjectDeckSettings } from "../deck-design-documents.ts";
import { DesignDocumentsList } from "./design-documents.jsx";

export function ProjectSettingsDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const [settings, setSettings] = useState<ProjectDeckSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .projectDeckSettings(project.id)
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const setUseWorkspace = async (value: boolean) => {
    if (!settings) return;
    const before = settings;
    setSettings({ ...settings, useWorkspaceDesignDocuments: value });
    setError(null);
    try {
      setSettings(await api.setProjectDeckSettings(project.id, { ...settings, useWorkspaceDesignDocuments: value }));
    } catch (cause) {
      setSettings(before);
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };

  const checkboxId = `project-use-workspace-docs-${project.id}`;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="project-settings">
        <DialogHeader>
          <DialogTitle>{project.title}</DialogTitle>
          <DialogDescription>Settings for this project alone. Everything else is set for the workspace, in Settings.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error ? <Banner tone="error" title={error} /> : null}
          <h3>Slide decks</h3>
          <label className="check" htmlFor={checkboxId}>
            <input
              id={checkboxId}
              type="checkbox"
              disabled={settings === null}
              checked={settings?.useWorkspaceDesignDocuments ?? true}
              onChange={(event) => void setUseWorkspace(event.target.checked)}
            />
            <span>
              Use the workspace's design documents for this project's decks
              <br />
              <span className="inline-note">Turned off, only the documents below are consulted.</span>
            </span>
          </label>
          <h3>This project's own design documents</h3>
          <p className="inline-note">Always consulted for this project's decks, before the workspace's.</p>
          <DesignDocumentsList projectId={project.id} emptyNote="None yet. This project's decks follow the workspace's design documents, if any." />
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { Link2Off, Trash2 } from "lucide-react";
import type {
  ImportResourceRecord,
  ImportResourceReleaseDisposition,
  ImportResourceSource,
} from "../../../../preload";
import { useI18n } from "../../../i18n";

type ManagedImportResourceActionsProps = {
  resource?: ImportResourceRecord;
  isBusy: boolean;
  onRelease: (
    resource: ImportResourceRecord,
    source: ImportResourceSource,
    disposition: ImportResourceReleaseDisposition
  ) => void;
};

export function ManagedImportResourceActions({
  resource,
  isBusy,
  onRelease,
}: ManagedImportResourceActionsProps): React.JSX.Element | null {
  const { t } = useI18n();
  if (!resource) {
    return null;
  }

  const deleteLabel = t("settings.importResourceRemove", {
    defaultValue: "Remove imported resource",
  });
  const adoptLabel = t("settings.importResourceKeepCopy", {
    defaultValue: "Keep local copy and remove import link",
  });

  return (
    <div className="import-resource-actions" aria-label={t("settings.importResourceSources", {
      defaultValue: "Import sources",
    })}>
      {resource.sources.map((source) => (
        <div className="import-resource-source" key={source.sourceId}>
          <span title={source.originPath}>{source.provider}</span>
          <button
            className="icon-btn ghost"
            onClick={() => onRelease(resource, source, "adopt")}
            type="button"
            disabled={isBusy}
            aria-label={adoptLabel}
            title={adoptLabel}
          >
            <Link2Off size={13} strokeWidth={1.8} />
          </button>
          <button
            className="icon-btn ghost danger"
            onClick={() => onRelease(resource, source, "delete")}
            type="button"
            disabled={isBusy}
            aria-label={deleteLabel}
            title={deleteLabel}
          >
            <Trash2 size={13} strokeWidth={1.8} />
          </button>
        </div>
      ))}
    </div>
  );
}

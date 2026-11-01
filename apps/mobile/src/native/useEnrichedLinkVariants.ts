import { useMemo } from "react";
import { Image } from "react-native";
import type {
  LinkPillContent,
  MarkdownDocumentAsset,
  MarkdownStyle,
} from "react-native-enriched-markdown";
import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { markdownLinkIconSource } from "../lib/markdownLinkIcons";
import {
  resolveMarkdownFileIcon,
  resolveMarkdownLinkIcon,
  resolveMarkdownLinkPresentation,
} from "../lib/markdownLinks";
import {
  parseRemoteFileHref,
  remoteFileChipLabel,
  resolveRemoteFileServer,
  type RemoteFileServerCandidate,
} from "../lib/remoteFileLinks";
import type {
  MarkdownLinkCustomization,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";
import {
  enrichedContextLinkPresentation,
  enrichedLinkVariantPattern,
  enrichedSkillDisplayName,
  enrichedSkillReference,
} from "../lib/enrichedLinkPresentation";

type LinkPresentation = MarkdownLinkCustomization & {
  readonly isFile?: boolean;
  /** Shown as its own text in the link color, with no pill. */
  readonly isText?: boolean;
};

function presentation(
  url: string,
  props: Pick<SelectableMarkdownTextProps, "linkCustomization" | "skills" | "textStyle">,
  remoteFileServers: ReadonlyArray<RemoteFileServerCandidate>,
): LinkPresentation | undefined {
  const custom = props.linkCustomization?.(url);
  if (custom) return custom;
  const context = enrichedContextLinkPresentation(url);
  if (context) return { color: context.color, icon: markdownFileIconSource(context.icon) };
  const skill = enrichedSkillReference(url, props.skills);
  if (skill)
    return {
      color: props.textStyle.skillTextColor,
      label: enrichedSkillDisplayName(skill),
      icon: markdownFileIconSource("mcp"),
    };
  // A file on a named server is a chip only when this client is connected to that server.
  const remoteFile = parseRemoteFileHref(url);
  if (remoteFile) {
    const server = resolveRemoteFileServer(remoteFile, remoteFileServers);
    return server._tag === "found"
      ? {
          color: props.textStyle.fileTextColor,
          label: remoteFileChipLabel(remoteFile, server.label),
          icon: markdownFileIconSource(resolveMarkdownFileIcon(remoteFile.path)),
          isFile: true,
        }
      : undefined;
  }
  const link = resolveMarkdownLinkPresentation(url);
  if (link.kind === "file")
    return {
      color: props.textStyle.fileTextColor,
      label: link.label,
      icon: markdownFileIconSource(link.icon),
      isFile: true,
    };
  const icon = link.kind === "external" ? resolveMarkdownLinkIcon(link.host) : null;
  return icon
    ? {
        color: props.textStyle.linkColor,
        icon: markdownLinkIconSource(icon),
        iconTintColor: props.textStyle.linkColor,
      }
    : undefined;
}

export function useEnrichedLinkVariants(
  assets: ReadonlyArray<MarkdownDocumentAsset>,
  props: SelectableMarkdownTextProps,
  remoteFileServers: ReadonlyArray<RemoteFileServerCandidate>,
) {
  const { linkCustomization, skills, textStyle } = props;
  const links = useMemo(() => {
    const byUrl = new Map<string, NonNullable<ReturnType<typeof presentation>>>();
    // A file link written with text of its own shows that text, as everywhere else in Markdown,
    // as a colored link rather than a pill: a pill is one unbroken run that cuts a long label
    // short. The file-name chip stands in only when no occurrence has text of its own, as for a
    // bare code span, whose text is the URL itself.
    const authored = new Set(
      assets
        .filter(
          (asset) => asset.kind === "link" && asset.altText !== "" && asset.altText !== asset.url,
        )
        .map((asset) => asset.url),
    );
    for (const asset of assets) {
      if (asset.kind !== "link" || byUrl.has(asset.url)) continue;
      const value = presentation(
        asset.url,
        { linkCustomization, skills, textStyle },
        remoteFileServers,
      );
      if (!value) continue;
      byUrl.set(
        asset.url,
        value.isFile && authored.has(asset.url) ? { color: value.color, isText: true } : value,
      );
    }
    return byUrl;
  }, [assets, linkCustomization, skills, textStyle, remoteFileServers]);
  const linkVariants = useMemo<MarkdownStyle["linkVariants"]>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => {
          const color = link.color ?? textStyle.fileTextColor;
          if (link.isText) {
            return [
              enrichedLinkVariantPattern(url),
              { fontFamily: textStyle.fontFamily, color, underline: false },
            ];
          }
          return [
            enrichedLinkVariantPattern(url),
            {
              pill: {
                borderColor: "transparent",
                borderWidth: 0,
                borderRadius: 6,
                paddingHorizontal: 5,
                paddingVertical: 2,
              },
              fontFamily: textStyle.fontFamily,
              color,
              underline: false,
              backgroundColor: "transparent",
            },
          ];
        }),
      ),
    [links, textStyle],
  );
  const linkPillContent = useMemo<Record<string, LinkPillContent>>(
    () =>
      Object.fromEntries(
        [...links].flatMap(([url, link]) =>
          link.isText
            ? []
            : [
                [
                  url,
                  {
                    label: link.label,
                    iconUri: link.icon ? Image.resolveAssetSource(link.icon)?.uri : undefined,
                    iconTintColor: link.iconTintColor,
                  },
                ] as const,
              ],
        ),
      ),
    [links],
  );
  return { linkVariants, linkPillContent };
}

import { Badge, Box, Flex, Heading, Text, chakra } from "@chakra-ui/react";
import { useId, type ReactNode } from "react";
import type { FeedStatus } from "@terminal/model/types";
import { STATUS_LABELS, STATUS_MEANINGS, STATUS_PALETTES } from "./format";

/** A text input with the page style. It takes every attribute of an `input`. */
export const TextInput = chakra("input", {
  base: {
    width: "100%",
    minHeight: "9",
    paddingX: "3",
    borderWidth: "1px",
    borderColor: "border",
    borderRadius: "md",
    backgroundColor: "bg",
    color: "fg",
    fontSize: "sm",
    _placeholder: { color: "fg.muted" },
    _focusVisible: { outline: "2px solid", outlineColor: "blue.focusRing", outlineOffset: "1px" },
    _disabled: { opacity: 0.6, cursor: "not-allowed" },
    _invalid: { borderColor: "red.solid" },
  },
});

/** A select with the page style. It takes every attribute of a `select`. */
export const SelectInput = chakra("select", {
  base: {
    width: "100%",
    minHeight: "9",
    paddingX: "2",
    borderWidth: "1px",
    borderColor: "border",
    borderRadius: "md",
    backgroundColor: "bg",
    color: "fg",
    fontSize: "sm",
    _focusVisible: { outline: "2px solid", outlineColor: "blue.focusRing", outlineOffset: "1px" },
    _disabled: { opacity: 0.6, cursor: "not-allowed" },
  },
});

/** A text area with the page style. */
export const TextAreaInput = chakra("textarea", {
  base: {
    width: "100%",
    minHeight: "20",
    padding: "3",
    borderWidth: "1px",
    borderColor: "border",
    borderRadius: "md",
    backgroundColor: "bg",
    color: "fg",
    fontSize: "sm",
    fontFamily: "mono",
    _focusVisible: { outline: "2px solid", outlineColor: "blue.focusRing", outlineOffset: "1px" },
  },
});

/** Props of {@link Field}. */
export type FieldProps = {
  readonly label: string;
  /** Builds the control. It receives the identifier that the label points at. */
  readonly children: (controlId: string) => ReactNode;
  readonly hint?: string;
  readonly error?: string | null;
};

/**
 * A label above a control, with an optional hint and error. The label is tied to the control by identifier.
 *
 * @param props The label, the control builder, the hint and the error.
 */
export const Field = ({ label, children, hint, error = null }: FieldProps) => {
  const controlId = useId();
  return (
    <Box>
      <chakra.label htmlFor={controlId} display="block" fontSize="sm" fontWeight="medium" marginBottom="1">
        {label}
      </chakra.label>
      {children(controlId)}
      {hint === undefined ? null : (
        <Text fontSize="xs" color="fg.muted" marginTop="1">
          {hint}
        </Text>
      )}
      {error === null ? null : (
        <Text role="alert" fontSize="xs" color="red.fg" marginTop="1">
          {error}
        </Text>
      )}
    </Box>
  );
};

/** Props of {@link Panel}. */
export type PanelProps = {
  readonly title: string;
  readonly children: ReactNode;
  /** The heading level, 2 to 4. Default: 2. */
  readonly level?: 2 | 3 | 4;
  readonly actions?: ReactNode;
};

/**
 * A titled region. A screen reader lists it as a region with the title as its name.
 *
 * @param props The title, the content and the actions.
 */
export const Panel = ({ title, children, level = 2, actions }: PanelProps) => {
  const headingId = useId();
  return (
    <Box as="section" aria-labelledby={headingId} borderWidth="1px" borderColor="border" borderRadius="lg" padding="3" backgroundColor="bg.subtle">
      <Flex justifyContent="space-between" alignItems="center" gap="2" marginBottom="2">
        <Heading as={`h${level}`} id={headingId} size="sm">
          {title}
        </Heading>
        {actions}
      </Flex>
      {children}
    </Box>
  );
};

/**
 * The status of a transfer, in words and in color. The color never carries the meaning alone.
 *
 * @param props The status.
 */
export const StatusBadge = ({ status }: { readonly status: FeedStatus }) => (
  <Badge colorPalette={STATUS_PALETTES[status]} variant="subtle" title={STATUS_MEANINGS[status]} whiteSpace="nowrap">
    {STATUS_LABELS[status]}
  </Badge>
);

/** A value in a monospace font that may break anywhere, for addresses and hashes. */
export const Mono = ({ children }: { readonly children: ReactNode }) => (
  <chakra.span fontFamily="mono" fontSize="xs" wordBreak="break-all">
    {children}
  </chakra.span>
);

/** A line with a muted label and a value. */
export const DataRow = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <Flex gap="2" fontSize="sm" flexWrap="wrap">
    <Text as="span" color="fg.muted" minWidth="9rem">
      {label}
    </Text>
    <Box as="span" flex="1" minWidth="0">
      {children}
    </Box>
  </Flex>
);

const NOTICE_PALETTES = { error: "red", warning: "orange", info: "blue" } as const;

/** A message that something failed or is empty. */
export const Notice = ({ tone, children }: { readonly tone: "error" | "warning" | "info"; readonly children: ReactNode }) => {
  const palette = NOTICE_PALETTES[tone];
  return (
    <Box role={tone === "error" ? "alert" : "status"} borderWidth="1px" borderColor={`${palette}.muted`} backgroundColor={`${palette}.subtle`} color={`${palette}.fg`} borderRadius="md" paddingX="3" paddingY="2" fontSize="sm">
      {children}
    </Box>
  );
};

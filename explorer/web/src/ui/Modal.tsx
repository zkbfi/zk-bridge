import { Box, Flex, Heading, IconButton } from "@chakra-ui/react";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";

/** Props of {@link Modal}. */
export type ModalProps = {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** The width of the panel in CSS units. Default: 40rem. */
  readonly width?: string;
  /** The element that gets focus when the dialog opens. Default: the dialog itself. */
  readonly initialFocusReference?: RefObject<HTMLElement | null>;
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

const focusableIn = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.closest("[hidden]") === null);

/**
 * A dialog. It labels itself with its title, moves focus inside when it opens, keeps Tab inside, closes on Escape, and
 * gives focus back to the element that opened it.
 *
 * @param props The title, the close handler, the content and the width.
 */
export const Modal = ({ title, onClose, children, width = "40rem", initialFocusReference }: ModalProps) => {
  const titleId = useId();
  const panelReference = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocusReference?.current ?? panelReference.current)?.focus();
    return () => opener?.focus();
  }, [initialFocusReference]);

  const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || panelReference.current === null) return;
    const items = focusableIn(panelReference.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    const onPanel = document.activeElement === panelReference.current;
    if (event.shiftKey && (document.activeElement === first || onPanel)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <Flex
      position="fixed"
      inset="0"
      zIndex="modal"
      backgroundColor="blackAlpha.600"
      alignItems={{ base: "stretch", md: "flex-start" }}
      justifyContent="center"
      paddingTop={{ base: "0", md: "6vh" }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <Box
        ref={panelReference}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
        width="100%"
        maxWidth={width}
        maxHeight={{ base: "100%", md: "88vh" }}
        overflowY="auto"
        backgroundColor="bg"
        color="fg"
        borderWidth="1px"
        borderColor="border"
        borderRadius="0"
        padding="4"
        _focusVisible={{ outline: "none" }}
      >
        <Flex justifyContent="space-between" alignItems="center" marginBottom="3" gap="2">
          <Heading as="h2" id={titleId} size="md">
            {title}
          </Heading>
          <IconButton aria-label="Close" variant="ghost" size="sm" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </IconButton>
        </Flex>
        {children}
      </Box>
    </Flex>
  );
};

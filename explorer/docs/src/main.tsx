import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DocsSite } from "./DocsSite";
import { SITE_PAGES } from "./pages";

const root = document.getElementById("root");
if (root === null) throw new Error("The page has no element with the identifier root.");

createRoot(root).render(
  <StrictMode>
    <ChakraProvider value={defaultSystem}>
      <DocsSite pages={SITE_PAGES} />
    </ChakraProvider>
  </StrictMode>,
);

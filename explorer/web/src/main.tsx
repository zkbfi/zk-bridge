import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Providers } from "./app/Providers";
import { createServices } from "./app/services";
import { Shell } from "./app/Shell";
import { loadPairConfig, loadSharedPair, readConfiguration, requestedPair, selectPair, withDeploymentText } from "./config/environment";
import { browserStorage } from "./search/recent-items";

const root = document.getElementById("root");
if (root === null) throw new Error("The page has no element with the identifier root.");
const mount = createRoot(root);

/** Shows a configuration problem as plain text. The page refuses to start with a bad configuration. */
const showStartupProblem = (message: string): void => {
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.style.cssText = "font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 1rem; border: 2px solid #b00020;";
  const title = document.createElement("h1");
  title.textContent = "The explorer cannot start";
  title.style.fontSize = "1.25rem";
  const text = document.createElement("p");
  text.textContent = message;
  box.append(title, text);
  root.replaceChildren(box);
};

const start = async (): Promise<void> => {
  const configuration = await withDeploymentText(selectPair(readConfiguration(import.meta.env), requestedPair(window.location)));
  const pair = await loadPairConfig(configuration);
  const sharedPair = await loadSharedPair(configuration);
  const services = createServices(configuration, pair, { sharedPair, storage: browserStorage() });
  mount.render(
    <StrictMode>
      <Providers services={services}>
        <Shell />
      </Providers>
    </StrictMode>,
  );
};

start().catch((error: unknown) => showStartupProblem(error instanceof Error ? error.message : String(error)));

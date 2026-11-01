import { TokenIcon as PackageTokenIcon, type TokenIconProps as PackageTokenIconProps } from "@zkb/react";
import lock from "../../public/icons/icons.lock.json";
import { loadImageServer } from "./image-server";

/** Props of {@link TokenIcon}. */
export type TokenIconProps = PackageTokenIconProps;

const shipped = lock as Readonly<Record<string, { readonly file: string }>>;

/**
 * A token's (or chain's) icon, with an optional chain badge (the component lives in `@zkb/react`). The dapp supplies the
 * copies the release ships and the image server the user chose in Settings.
 *
 * @param props The subject, the badge and the symbol.
 */
export const TokenIcon = (props: TokenIconProps) => <PackageTokenIcon imageServer={loadImageServer()} shipped={shipped} {...props} />;

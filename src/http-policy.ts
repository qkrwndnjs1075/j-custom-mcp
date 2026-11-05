import type { AfterResponseHook } from "ky";

class ProviderRedirectError extends Error {
  override readonly name = "ProviderRedirectError";
  constructor() {
    super("Provider redirects are not permitted");
  }
}

export const rejectProviderRedirect: AfterResponseHook = (_request, _options, response) => {
  if (response.status >= 300 && response.status < 400) throw new ProviderRedirectError();
};

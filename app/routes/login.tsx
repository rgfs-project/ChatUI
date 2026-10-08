import { redirect, useSearchParams } from "react-router";
import { AuthForm } from "../components/AuthForm";
import { appContext } from "../context";
import { safeReturnTo } from "../lib/api";
import type { Route } from "./+types/login";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Sign in · ChatUI" }];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { auth, services } = context.get(appContext);
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  if (auth) throw redirect(returnTo);
  await services.auth.refreshFirstRun();
  return { registrationOpen: services.auth.registrationOpen };
}

export default function Login({ loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  return (
    <AuthForm
      mode="login"
      returnTo={params.get("returnTo")}
      footer={
        loaderData.registrationOpen ? (
          <p className="muted center">
            New here? <a href="/register">Create an account</a>
          </p>
        ) : null
      }
    />
  );
}

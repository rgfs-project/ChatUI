import { data, redirect } from "react-router";
import { AuthForm } from "../components/AuthForm";
import { appContext } from "../context";
import type { Route } from "./+types/register";

export function meta(): Route.MetaDescriptors {
  return [{ title: "Create account · ChatUI" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { auth, services } = context.get(appContext);
  if (auth) throw redirect("/chat");
  await services.auth.refreshFirstRun();
  if (!services.auth.registrationOpen) throw data("Not found", { status: 404 });
  return null;
}

export default function Register() {
  return (
    <AuthForm
      mode="register"
      returnTo={null}
      footer={
        <p className="muted center">
          Have an account? <a href="/login">Sign in</a>
        </p>
      }
    />
  );
}

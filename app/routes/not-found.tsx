import { data } from "react-router";

export function loader() {
  throw data("Not found", { status: 404 });
}

export default function NotFound() {
  return null;
}

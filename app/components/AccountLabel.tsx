/** Avatar and name: the account menu trigger and its placeholder share it. */
export function AccountLabel({ username }: { username: string }) {
  return (
    <>
      <span className="avatar" aria-hidden>
        {(username.at(0) ?? "?").toUpperCase()}
      </span>
      <span data-testid="signed-in-user">{username}</span>
    </>
  );
}

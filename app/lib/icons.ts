/**
 * The icon names `s-icon` accepts.
 *
 * `@shopify/polaris-types` never exports its `IconType` union — it only reaches
 * us through the JSX element registration — so the union is recovered from
 * there. Typing an icon prop as a plain `string` compiles at the definition and
 * then fails at the `s-icon` call site, which is the same widening trap as
 * `s-badge`'s `tone`.
 */
export type IconName = NonNullable<JSX.IntrinsicElements["s-icon"]["type"]>;

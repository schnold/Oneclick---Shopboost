/// <reference types="@shopify/app-bridge-types" />
// The reference above must stay on the first line — triple-slash directives are
// ignored once any statement precedes them.
//
// It registers the App Bridge web components (`s-app-nav`, `s-title-bar`, …),
// which render in the admin chrome outside our iframe and whose JSX types live
// in `@shopify/app-bridge-types` rather than `@shopify/polaris-types`. Nothing
// else in the app imports that package at the type level, so without this
// reference `s-app-nav` silently falls out of `JSX.IntrinsicElements`.

declare module "*.css";

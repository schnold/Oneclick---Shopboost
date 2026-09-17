import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

/**
 * The public page, seen only outside the Shopify admin.
 *
 * Installation is meant to start from a Shopify-owned surface — the App Store
 * listing or the Dev Dashboard — so this page does not advertise itself as an
 * install route. The shop-domain form is the documented fallback for a merchant
 * who reaches the app URL directly, and it renders only when `login` is
 * available.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // A request carrying ?shop= came from Shopify; send it straight into the app.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Shopboost</h1>
        <p className={styles.text}>
          One press optimizes your whole shop — images, search listings,
          structured data and storefront speed — and every change can be undone.
        </p>

        <ul className={styles.list}>
          <li>
            <strong>Smaller images, same pictures</strong>. Product photos are
            recompressed in place, so nothing is re-linked or reordered, and the
            originals are kept so any image can be restored.
          </li>
          <li>
            <strong>Search listings that are actually filled in</strong>. Meta
            titles, descriptions and image alt text are written for products that
            are missing them. Copy you wrote yourself is never overwritten.
          </li>
          <li>
            <strong>Answers for AI search</strong>. Product and FAQ structured
            data helps Google, ChatGPT and Perplexity describe your products
            accurately. Generated answers wait for your approval first.
          </li>
          <li>
            <strong>Speed you can act on</strong>. Your storefront is measured
            with PageSpeed Insights and checked against Shopify&rsquo;s own
            performance guidance, with the exact change to make in your theme.
          </li>
        </ul>

        <p className={styles.text}>
          Scanning is free. You only pay when you apply changes.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Already installed? Enter your shop to sign in</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="example.myshopify.com"
              />
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
      </div>
    </div>
  );
}

/* eslint-disable sonarjs/no-duplicate-string */
// Backend, lol (it serves the frontend)
// This is the server side renderer
import { urlencoded, json } from "body-parser";
import compression from "compression";
import crypto from "crypto";
import Express from "express";
import type { RequestHandler } from "express";
import { create } from "express-handlebars";
import helmet from "helmet";
// eslint-disable-next-line unicorn/import-style
import { join } from "path";
import favicon from "serve-favicon";
import serverless from "serverless-http";
import Stripe from "stripe";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
// eslint-disable-next-line node/no-unpublished-import
import type { EmailPayload } from "@dazser/mailer/dist/merge";
import calculateFee from "../fee";
import { getStripePublicKey, getStripePrivateKey } from "./get-stripe-keys";

interface InvoicePayload {
  amount: string;
  email: string;
  invoice: string;
}

interface FrontEndForm {
  amount: string;
  email: string;
  invoice: string;
  totalAmount: string;
}

interface CheckoutSessionSucceededObject {
  amount_total: number;
  client_reference_id: string;
  customer_email: string;
  metadata: {
    jkAmount: string;
    jkInvoice: string;
  };
  payment_intent: string;
  payment_status: string;
}

export interface ParametersDictionary {
  [key: string]: string;
}

interface RequestParameters<T extends ParametersDictionary>
  extends Express.Request {
  params: T;
}

const parseInfo = (info: string): InvoicePayload => {
  // Now, setup any passed variables
  try {
    return JSON.parse(
      decodeURIComponent(Buffer.from(info, "base64").toString())
    ) as InvoicePayload;
  } catch (error) {
    // Something is wrong with the info's encoding
    console.error("Bad Params", {
      error,
      info,
    });
    return {
      amount: "",
      email: "",
      invoice: "",
    };
  }
};

const notify = async (payload: EmailPayload): Promise<boolean> => {
  const sqs = new SQSClient({
    region: "us-east-1",
  });
  try {
    const command = new SendMessageCommand({
      MessageBody: JSON.stringify(payload),
      QueueUrl: process.env["SQS_QUEUE"] as string,
    });
    await sqs.send(command);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
};

// This defines the nonce used in the Script nonce tag for CSP purposes.
const nonce = crypto.randomBytes(16).toString("hex");

const app = Express();
// Set up Helmet
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "connect-src": [
          "'self'",
          "https://google.com",
          "https://www.googletagmanager.com",
          "https://stats.g.doubleclick.net",
          "https://checkout.stripe.com",
          "https://api.stripe.com",
        ],
        "frame-src": [
          "https://js.stripe.com",
          "https://checkout.stripe.com",
          "https://hooks.stripe.com",
        ],
        "img-src": [
          "'self'",
          "data:",
          "https://www.google.com",
          `'nonce-${nonce}'`,
          "https://*.stripe.com",
        ],
        "report-uri": ["https://dazser.report-uri.com/r/d/csp/enforce"],
        "script-src": [
          "'self'",
          "https://js.stripe.com",
          "https://checkout.stripe.com",
          "https://polyfill.io",
          "https://www.googletagmanager.com",
          `'nonce-${nonce}'`,
        ],
        "script-src-elem": [
          "'self'",
          "https://js.stripe.com",
          "https://polyfill.io",
          "https://www.googletagmanager.com",
          `'nonce-${nonce}'`,
        ],
        "style-src": ["'self'", "https://cdn.jsdelivr.net"],
        "style-src-elem": ["'self'", "https://cdn.jsdelivr.net"],
      },
    },
    // Need to disable this because stripe doesn't set the
    // crossorigin attribute on the iframes or scripts it brings in
    crossOriginEmbedderPolicy: false,
  }) as RequestHandler
);
app.use(compression());
app.use(favicon(join(__dirname, "..", "..", "public", "favicon.ico")));
app.use(Express.static(join(__dirname, "..", "..", "public")));
app.use(urlencoded({ extended: false }) as RequestHandler);
app.use(json() as RequestHandler);

const hbs = create({
  extname: ".hbs",
});

// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.engine("hbs", hbs.engine);
app.set("view engine", "hbs");
app.set("views", join(__dirname, "..", "..", "views"));

app.get("/old", (_request: Express.Request, response: Express.Response) => {
  // This path is for outdated browsers
  return response.status(200).render("old", { nonce });
});

app.get("/success", (_request: Express.Request, response: Express.Response) => {
  // This path is for outdated browsers
  return response.status(200).render("success", { nonce });
});

app.post(
  "/webhook/:city",
  (
    request: RequestParameters<{ city: string }>,
    response: Express.Response
  ) => {
    // This deals with the web hook from Stripe
    const payload = request.body as Stripe.Event;
    // const signature = request.headers["Stripe-Signature"];

    // console.log("Request", JSON.stringify(request));
    // console.log("Stripe Signature", request.headers["stripe-signature"]);

    // get region num
    // const key = getStripePrivateKey(request.params.city);

    // const endpointSecret = getStripeWebhookSigningKey(request.params.city);

    /* if (!endpointSecret && !signature) {
      console.error(
        "Missing Endpoint Secret or Stripe Signature",
        endpointSecret,
        signature
      );
      response.sendStatus(500);
    }

    const stripe = new Stripe(key.stripePrivateKey, {
      apiVersion: "2020-08-27",
      typescript: true,
    });

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        payload,
        // @ts-expect-error I already checked if signature exists
        signature,
        endpointSecret
      );
    } catch (error) {
      console.error("Webhook Error", error);
      response.sendStatus(500);
    }

    // Create a notify payload for sqs
    // @ts-expect-error Event exists
    const charge = event.data.object as CheckoutSessionSucceededObject;

    // @ts-expect-error Event exists
    const created = new Date(event.created * 1000);
    */

    const charge = payload.data.object as CheckoutSessionSucceededObject;

    const created = new Date(payload.created * 1000);

    const key = getStripePublicKey(request.params.city);

    const body = `<table style="width:100%;" border="1">
      <tr><td colspan="2">A Payment has succeeded.</td></tr>
      <tr><td>Email</td><td>${charge.customer_email}</td></tr>
      <tr><td>JK Invoice</td><td>${charge.metadata.jkInvoice}</td></tr>
      <tr><td>JK Amount</td><td>${charge.metadata.jkAmount}</td></tr>
      <tr><td>Payment on</td><td>${created.toLocaleDateString(
        "en-US"
      )}</td></tr>
      <tr><td>Payment ID</td><td><a href='https://dashboard.stripe.com/payments/${
        charge.payment_intent
      }'>${charge.payment_intent}</a></td></tr>
      <tr><td>Payment Status</td><td>${charge.payment_status}</td></tr>
      </table>`;

    notify({
      body,
      from: { address: "network.admin@dazser.com", name: "Payment Portal" },
      regionnum: key.regionNumber,
      subject: "Payment Notification",
      // @ts-expect-error I know it's an enum, but I'm using as a string
      template: "notify.html",
      to:
        process.env["NODE_ENV"] === "production"
          ? "controller@dazser.com, accounting1@dazser.com, accounting2@dazser.com, collections2@dazser.com, collections3@dazser.com"
          : "kyle@dazser.com",
    })
      .then((success) => {
        if (success) {
          return response.sendStatus(200);
        }
        return response.sendStatus(500);
      })
      .catch((error) => {
        console.error("Stripe Webhook Error", error);
        return response.sendStatus(500);
      });
  }
);

app.post(
  "/createCheckoutSession/:city",
  (
    request: RequestParameters<{ city: string }>,
    response: Express.Response
  ) => {
    // This api endpoint will create the checkout session id
    const { city } = request.params;
    const parsed = request.body as FrontEndForm;
    const key = getStripePrivateKey(city);
    if (key.stripePrivateKey === "") {
      // The city is incorrect, idk what is wrong...
      console.error("Invalid City");
    }

    // Calculate the fee again based on the amount requested.
    const fee = calculateFee(
      Number.parseFloat(parsed.amount.replace(/[^\d.-]+/g, ""))
    );

    // Check to see if the fee we told them would be the fee calculated
    if (fee.display.total !== parsed.totalAmount) {
      // Something is wrong
      console.error("THE PARSED AND CALCULATED FEE ARE DIFFERENT", parsed, fee);
    }

    const stripe = new Stripe(key.stripePrivateKey, {
      apiVersion: "2022-11-15",
      typescript: true,
    });

    // eslint-disable-next-line promise/catch-or-return, @typescript-eslint/no-floating-promises
    stripe.checkout.sessions
      .create({
        cancel_url: "https://pay.dazser.com/",
        client_reference_id: parsed.invoice,
        customer_email: parsed.email,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                images: [
                  "https://d3bog92s18hu5m.cloudfront.net/cleaned-badge.jpg",
                ],
                name: "Jani-King Janitorial Services",
              },
              unit_amount: Number.parseFloat(fee.total),
            },
            quantity: 1,
          },
        ],
        metadata: {
          // eslint-disable-next-line prettier/prettier
          "jkAmount": parsed.amount.replace(/[^\d.-]+/g, ""),
          // eslint-disable-next-line prettier/prettier
          "jkInvoice": parsed.invoice,
        },
        mode: "payment",
        success_url: "https://pay.dazser.com/success",
      })
      .then((session) => {
        return response.json({ id: session.id });
      });
  }
);

app.get(
  "/:city/:info?",
  (
    request: RequestParameters<{ city: string; info: string }>,
    response: Express.Response
  ) => {
    // This api endpoint will return the server side rendered checkout page
    // Verify the city
    const { city, info } = request.params;
    const { cityName, regionNumber, stripePublicKey } =
      getStripePublicKey(city);

    // If the city doesn't work, render the map
    if (cityName === "") {
      return response.status(400).render("map", { nonce });
    }

    let parsed;
    let fee;
    if (info) {
      parsed = parseInfo(info);
      try {
        fee = calculateFee(Number.parseFloat(parsed.amount));
      } catch (error) {
        console.error(error, `Info: ${info}`);
        return response.status(400).render("map", { nonce });
      }
    }

    const context = {
      analytics: {
        key: process.env["ANALYTICS_KEY"] as string,
      },
      form: {
        amount: parsed?.amount ?? "",
        email: parsed?.email ?? "",
        fee: fee?.display.fee ?? "",
        invoice: parsed?.invoice ?? "",
        regionName: city,
        regionNum: regionNumber,
        total: fee?.display.total ?? "",
      },
      nonce,
      stripe: {
        publicKey: stripePublicKey,
      },
      ux: {
        company: cityName,
      },
    };
    return response.status(200).render("portal", context);
  }
);

app.get("/", (_request: Express.Request, response: Express.Response) => {
  return response.status(200).render("map", { nonce });
});

app.get("*", (_request: Express.Request, response: Express.Response) => {
  return response.sendStatus(404);
});

const sApp = serverless(app);

export default async (
  event: AWSLambda.APIGatewayEvent,
  context: AWSLambda.Context
): Promise<AWSLambda.APIGatewayProxyResult> => {
  return (await (sApp(
    event,
    context
  ) as unknown)) as AWSLambda.APIGatewayProxyResult;
};

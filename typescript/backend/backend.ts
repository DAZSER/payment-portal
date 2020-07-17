/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// Backend
import Big from "big.js";
import Stripe from "stripe";
import Validator from "validator";
import email from "./email";
import calculateFee from "../fee";
import logger, { EventType } from "./logger";

interface ReturnData {
  message: string;
}

export default async (
  event: AWSLambda.APIGatewayEvent
): Promise<AWSLambda.APIGatewayProxyResult> => {
  // This is the return variable
  const data: ReturnData = {
    message: "",
  };

  // Get the form variables
  const form = JSON.parse(event.body as string);
  // Also parse the token
  form.stripeToken = JSON.parse(form.stripeToken);

  // Send off an insert into the log event
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  logger(EventType.INSERT, form);

  // Validate Email
  if (!Validator.isEmail(form.email)) {
    data.message =
      "Invalid email address, please double check your email address and try again.";
    return {
      body: JSON.stringify({ data }),
      statusCode: 422,
    };
  }

  // Validate Amount (without the fee)
  const amount = Big(Number.parseFloat(form.amount.replace(/[^\d.-]+/g, "")));
  if (amount.lt(0) || amount.gt(970999.69)) {
    data.message =
      "Amount is invalid, please enter an amount greater than zero.";
    return {
      body: JSON.stringify({ data }),
      statusCode: 422,
    };
  }

  const amounts = calculateFee(
    Number.parseFloat(form.amount.replace(/[^\d.-]+/g, ""))
  );
  const chargedAmountInCents = new Big(amounts.total);

  // Check to make sure the charged amount is what we told the user it would be
  const totalAmount = new Big(
    Number.parseFloat(form.total_amount.replace(/[^\d.-]+/g, ""))
  );
  const whatWeToldThemItWouldBe = totalAmount.times(100);

  if (!chargedAmountInCents.eq(whatWeToldThemItWouldBe)) {
    // ERROR, The amount I calculated is not what I told them it would be!
    const messageId = await email(
      JSON.stringify({
        backEnd: chargedAmountInCents.toString(),
        error:
          "The frontend calculation and backend calculation did not agree.",
        form,
        frontEnd: whatWeToldThemItWouldBe.toString(),
      })
    );
    data.message = `An unexpected error occured. You're card has not been charged. The error has been logged.\n Message ID: ${messageId}`;
    return {
      body: JSON.stringify({ data }),
      statusCode: 500,
    };
  }

  // Figure out the key
  let privateKey: string;
  switch (form.region_num) {
    case "1":
      privateKey = process.env.STRIPE_TAMPA_PRIVATE_KEY as string;
      break;
    case "2":
      privateKey = process.env.STRIPE_ORLANDO_PRIVATE_KEY as string;
      break;
    case "3":
      privateKey = process.env.STRIPE_BIRMINGHAM_PRIVATE_KEY as string;
      break;
    case "4":
      privateKey = process.env.STRIPE_BALTIMORE_PRIVATE_KEY as string;
      break;
    default:
      console.error("Bad Region", form);
      data.message = "Bad Region Number";
      return {
        body: JSON.stringify({
          data,
        }),
        statusCode: 500,
      };
  }

  const stripe = new Stripe(privateKey, {
    apiVersion: "2020-03-02",
  });

  // GO AHEAD WITH THE CHARGE!!
  /*
  stripe.on("request", (e) => {console.log(e);});
  stripe.on("response", (e) => {console.log(e);});
  */

  try {
    const charge = await stripe.charges.create({
      amount: Number.parseInt(chargedAmountInCents.toString(), 10),
      currency: "usd",
      description: `Jani-King Cleaning Services - ${
        form.invoice as string
      } - includes convenience fee`,
      metadata: {
        email: form.email,
        invoice: form.invoice,
      },
      receipt_email: form.email,
      source: form.stripeToken.id,
    });

    // The card has been charged successfully!
    // console.log(charge);
    // Now log the charge into our database (api call?)
    try {
      await logger(EventType.UPDATE, charge);
    } catch (error) {
      console.error(error);
    }

    data.message = `Your account has been charged and a receipt has been emailed to you. You may now close this window. \n\n Thank you for your business! \n\n Transaction ID: ${charge.id}`;

    return {
      body: JSON.stringify({
        data,
      }),
      statusCode: 200,
    };
  } catch (error) {
    // THERE IS AN ERROR, the card was not charged!
    // console.log(error);
    await email(JSON.stringify({ error, form }));
    data.message = `An unexpected error has occured.\n${
      error.message as string
    }\nCode: ${error.code as string}`;
    return {
      body: JSON.stringify({
        data,
      }),
      statusCode: 200,
    };
  }
};

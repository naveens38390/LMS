import { Webhook } from "svix";
import User from "../models/User.js"
import Stripe from "stripe";
import { Purchase } from "../models/Purchase.js";
import Course from "../models/Course.js";

// API Controller Function to Manage Clerk User with Database

export const clerkWebhooks = async (req, res)=>{
    try {
        const whook = new Webhook(process.env.CLERK_WEBHOOK_SECRET)

        await whook.verify(JSON.stringify(req.body), {
            "svix-id": req.headers["svix-id"],
            "svix-timestamp": req.headers["svix-timestamp"],
            "svix-signature": req.headers["svix-signature"]
        })

        const {data, type} = req.body

        switch (type) {
            case 'user.created': {
                const userData = {
                    _id: data.id,
                    email: data.email_addresses[0].email_address,
                    name: data.first_name + " " + data.last_name,
                    imageUrl: data.image_url,
                }
                await User.create(userData)
                res.json({})
                break;
            }
                
            case 'user.updated': {
                const userData = {
                    email: data.email_address[0].email_address,
                    name: data.first_name + " " + data.last_name,
                    imageUrl: data.image_url,
                }
                await User.findByIdAndUpdate(data.id, userData)
                res.json({})
                break;
            }

            case 'user.deleted' : {
                await User.findByIdAndDelete(data.id)
                res.json({})
                break;
            }
        
            default:
                break;
        }
    } catch (error) {
        res.json({success: false, message: error.message})
    }
}

const stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY)

export const stripeWebhooks = async (request, response) => {
    const sig = request.headers['stripe-signature'];

    let event;

    try {
        event = stripeInstance.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    }
    catch (err) {
        response.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            const { purchaseId } = session.metadata;

            try {
                const purchaseData = await Purchase.findById(purchaseId);
                if (!purchaseData) {
                    console.error(`Purchase not found: ${purchaseId}`);
                    break;
                }

                const userData = await User.findById(purchaseData.userId);
                const courseData = await Course.findById(purchaseData.courseId.toString());

                courseData.enrolledStudents.push(userData);
                await courseData.save();

                userData.enrolledCourses.push(courseData._id);
                await userData.save();

                purchaseData.status = "completed";
                await purchaseData.save();
                console.log(`Purchase ${purchaseId} marked as completed`);
            } catch (error) {
                console.error(`Error processing checkout.session.completed: ${error.message}`);
            }
            break;
        }

        case 'payment_intent.succeeded': {
            const paymentIntent = event.data.object;
            const paymentIntentId = paymentIntent.id;

            try {
                const session = await stripeInstance.checkout.sessions.list({
                    payment_intent: paymentIntentId,
                    limit: 1
                });

                if (session.data.length === 0) {
                    console.error(`No session found for payment_intent: ${paymentIntentId}`);
                    break;
                }

                const { purchaseId } = session.data[0].metadata;
                const purchaseData = await Purchase.findById(purchaseId);
                if (!purchaseData) {
                    console.error(`Purchase not found: ${purchaseId}`);
                    break;
                }

                // Only update if not already completed (in case both events fire)
                if (purchaseData.status !== 'completed') {
                    const userData = await User.findById(purchaseData.userId);
                    const courseData = await Course.findById(purchaseData.courseId.toString());

                    courseData.enrolledStudents.push(userData);
                    await courseData.save();

                    userData.enrolledCourses.push(courseData._id);
                    await userData.save();

                    purchaseData.status = "completed";
                    await purchaseData.save();
                    console.log(`Purchase ${purchaseId} marked as completed via payment_intent`);
                }
            } catch (error) {
                console.error(`Error processing payment_intent.succeeded: ${error.message}`);
            }
            break;
        }

        case 'payment_intent.payment_failed': {
            const paymentIntent = event.data.object;
            const paymentIntentId = paymentIntent.id;

            try {
                const session = await stripeInstance.checkout.sessions.list({
                    payment_intent: paymentIntentId,
                    limit: 1
                });

                if (session.data.length === 0) {
                    console.error(`No session found for payment_intent: ${paymentIntentId}`);
                    break;
                }

                const { purchaseId } = session.data[0].metadata;
                const purchaseData = await Purchase.findById(purchaseId);
                if (purchaseData) {
                    purchaseData.status = "failed";
                    await purchaseData.save();
                    console.log(`Purchase ${purchaseId} marked as failed`);
                }
            } catch (error) {
                console.error(`Error processing payment_intent.payment_failed: ${error.message}`);
            }
            break;
        }

        default:
            console.log(`Unhandled event type: ${event.type}`);
    }

    // Return a response to acknowledge receipt of the event
    response.json({received: true});
}
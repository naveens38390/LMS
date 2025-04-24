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
                    email: data.email_addresses[0].email_address,
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
        event = Stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    }
    catch (err) {
        console.error("Webhook signature verification failed:", err.message);
        return response.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        // Handle the event
        switch (event.type) {
            case 'payment_intent.succeeded': {
                const paymentIntent = event.data.object;
                const paymentIntentId = paymentIntent.id;

                const session = await stripeInstance.checkout.sessions.list({
                    payment_intent: paymentIntentId
                });

                // Check if session data exists
                if (!session.data || session.data.length === 0) {
                    console.error("No session found for payment intent:", paymentIntentId);
                    return response.status(400).json({ success: false, message: 'No session found' });
                }

                const { purchaseId } = session.data[0].metadata;
                
                if (!purchaseId) {
                    console.error("Missing purchaseId in session metadata");
                    return response.status(400).json({ success: false, message: 'Missing purchaseId' });
                }

                const purchaseData = await Purchase.findById(purchaseId);
                if (!purchaseData) {
                    console.error("Purchase not found:", purchaseId);
                    return response.status(404).json({ success: false, message: 'Purchase not found' });
                }

                const userData = await User.findById(purchaseData.userId);
                const courseData = await Course.findById(purchaseData.courseId.toString());

                courseData.enrolledStudents.push(userData);
                await courseData.save();

                userData.enrolledCourses.push(courseData._id);
                await userData.save();

                purchaseData.status = 'completed';
                await purchaseData.save();

                break;
            }

            case 'checkout.session.completed': {
                const session = event.data.object;
            
                console.log("Received checkout.session.completed with metadata:", session.metadata);
            
                const purchaseId = session.metadata?.purchaseId;
            
                if (!purchaseId) {
                    console.error("Missing purchaseId in session metadata");
                    return response.status(400).json({ success: false, message: 'Missing purchaseId' });
                }
            
                const purchase = await Purchase.findById(purchaseId);
                if (!purchase) {
                    console.error("Purchase not found:", purchaseId);
                    return response.status(404).json({ success: false, message: 'Purchase not found' });
                }
                
                // Check if purchase is already completed
                if (purchase.status === 'completed') {
                    console.log("Purchase already completed:", purchaseId);
                    return response.json({ received: true, message: 'Purchase already processed' });
                }
                
                // Get user and course data
                const userData = await User.findById(purchase.userId);
                const courseData = await Course.findById(purchase.courseId.toString());
                
                if (!userData || !courseData) {
                    console.error("User or course not found");
                    return response.status(404).json({ success: false, message: 'User or course not found' });
                }
                
                // Add student to course's enrolled students
                courseData.enrolledStudents.push(userData);
                await courseData.save();
                
                // Add course to user's enrolled courses
                userData.enrolledCourses.push(courseData._id);
                await userData.save();
                
                // Update purchase status
                purchase.status = 'completed';
                await purchase.save();
                
                break;
            }
               
            case 'payment_intent.payment_failed': {
                const paymentIntent = event.data.object;
                const paymentIntentId = paymentIntent.id;

                try {
                    const session = await stripeInstance.checkout.sessions.list({
                        payment_intent: paymentIntentId
                    });

                    if (!session.data || session.data.length === 0) {
                        console.error("No session found for failed payment intent:", paymentIntentId);
                        return response.status(400).json({ success: false, message: 'No session found' });
                    }

                    const { purchaseId } = session.data[0].metadata;
                    
                    if (!purchaseId) {
                        console.error("Missing purchaseId in session metadata");
                        return response.status(400).json({ success: false, message: 'Missing purchaseId' });
                    }
                    
                    const purchaseData = await Purchase.findById(purchaseId);
                    if (!purchaseData) {
                        console.error("Purchase not found:", purchaseId);
                        return response.status(404).json({ success: false, message: 'Purchase not found' });
                    }
                    
                    purchaseData.status = 'failed';
                    await purchaseData.save();
                } catch (error) {
                    console.error("Error processing payment_intent.payment_failed:", error.message);
                    return response.status(500).json({ success: false, message: 'Error processing failed payment' });
                }
                
                break;
            }
            
            default:
                console.log(`Unhandled event type ${event.type}`);
        }

        // Return a response to acknowledge receipt of the event
        return response.json({received: true});
    } catch (error) {
        console.error("Webhook internal error:", error.message);
        return response.status(500).send("Internal Error");
    }
}
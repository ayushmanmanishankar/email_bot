import { GoogleGenerativeAI } from "@google/generative-ai";


export async function respond_mail(email) {
  const ai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

  //context

  const context = `
  CubeRoot : Voice AI That Works Like Your Best Agent, at Scale
Overcome language barriers, high costs, and inadequate support, ensuring top-notch customer and citizen experiences. Build tailored Gen AI Voice Agents/bots, providing 24/7 assistance, cutting operational costs, ensuring security, and delivering scalable intelligent interactions.


Conversational Intelligence
Enabling enterprises to engage customers with natural, human-like voice interactions
CubeRoot Voice AI Agents replicate real conversations with contextual understanding, natural intonation, and support for multiple Indian languages. This ensures customers feel heard, understood, and valued at every touchpoint.

Operational Agility
Optimizing costs and boosting performance across customer engagement
CubeRoot qualifies and routes leads instantly, ensuring sales teams focus only on high-value prospects while reducing manual effort.



Enterprise Readiness
Secure, compliant, and designed for mission-critical deployments
End-to-end encryption, secure hosting in India, and role-based access ensure compliance with RBI and enterprise IT policies.

Amplify the Power of CubeRoot with Advanced AI Modules & Integrations
CubeRoot’s suite of AI modules and integrations is purpose-built to elevate your Voice AI Agents, delivering deeper automation, faster response times, and seamless enterprise connectivity for superior customer experiences.

Speech-to-Text
(STT)
Reverie's Speech-to-Text API empowers IndoCord by converting spoken words into text, enhancing the platform's voice bot capabilities.

Accurate Transcription: Enables voice interaction, converting spoken commands into accurate text inputs for bots.
Seamless Voice Integration: Enhances user experience by enabling natural voice interactions within chatbots.
Multilingual Support: Ensures effective communication by transcribing multiple Indian languages accurately.
Text-to-Speech
(TTS)
Reverie's Text-to-Speech API enriches IndoCord by converting written text into spoken words, enhancing the platform's voice capabilities.

Adaptive and Real-time Processing: Employs adaptive technology for real-time processing, ensuring dynamic adjustments to pacing, tone, and emphasis. 
Customizable Voice Generation: Allows businesses to tailor voice outputs (male/female voices) according to brand requirements.
Multiple Language Support: Delivers spoken content in various languages, broadening reach and accessibility. 
Conversation Orchestration
Cuberoot’s Conversation Orchestration engine empowers enterprises by seamlessly connecting the Voice AI Agent with backend systems, ensuring every interaction leads to smart, outcome-driven actions.

Workflow Automation: Triggers actions such as updating CRM records, sending reminders, or raising service tickets directly from conversations.
System Integration: Connects smoothly with dialers, CRMs, payment gateways, and ticketing platforms for end-to-end automation.
Context Preservation: Maintains conversational context across multiple touchpoints, enabling smooth handovers between human agents and AI.
 
Neural Machine Translation (NMT)
Reverie's Neural Machine Translation API enriches IndoCord by facilitating seamless translation between languages.

Efficient Language Translation: Allows for fluid communication by translating text inputs accurately.
Cross-Lingual Conversations: Enables multilingual bots, fostering communication across diverse language speakers.
Real-time Translation: Facilitates instantaneous translation, enhancing multiregional user engagement.
Analytics & Reporting
Cuberoot’s Analytics and Reporting module transforms call data into actionable business intelligence, helping enterprises optimize performance and outcomes.

Real-time Dashboards: Track live call metrics such as duration, response rates, and resolution outcomes.
Performance Insights: Identify patterns in lead conversion, collections efficiency, and customer sentiment.
Data-driven Decisions: Enable business leaders to refine strategies with clear visibility into agent performance and ROI impact.
Engage Customers with Human-like Voice Conversations, at Scale
Cuberoot Voice AI Agent delivers 24/7 automated calling, enabling enterprises to reach, qualify, and support customers in their preferred language — faster, smarter, and more cost-efficient.

Design
Deploy
Integrate
Test
Go Live
All in 14 Days
77%
Increase in Customer Reach

80%
Leads Qualified within Minutes

60%
Reduction in Calling Costs

50%
Improvement in Customer Satisfaction

87%
Reduction in Scalability

Experiences Designed to Engage, Every Step of the Way.
For banks and financial institutions, technology investments hinge on several key criteria: flexibility, customization capabilities, process automation, 99% uptime, the technology partner’s in-house tech-stack and proven industry experience. Voice AI Agents, in particular, have demonstrated their capability in automating repetitive queries, lead generation, and lead qualification. As AI models continue to learn and evolve, these agents will be able to handle more complex customer queries in the future.
  `

  const prompt = {
    model: "gemini-2.5-flash",
    contents: `You are an expert email responder. A user has sent the following email, which is in HTML format. Please analyze the email and generate a professional and helpful response, also in HTML format. Maintain the original tone of the email as much as possible. Here is the context of the company: ${context}\n\n Here is the email content:\n\n${email}`
  }

  const repsonse = await ai.models.generateContent(prompt);
  const text = repsonse.text();
  console.log(text);
  
//   await sendMail(email, text);
}

async function sendMail(email, response) {
    //use sendgrid
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    const fromEmail = 'ayushman.manishankar@reverieinc.com';
    const toEmail = email.from;

    const msg = {
        to: toEmail,
        from: fromEmail,
        subject: 'Response to your email',
        html: response
    }

    try {
        await sgMail.send(msg);
        console.log('Email sent successfully');
    } catch (error) {
        console.error('Error sending email:', error);
    }
}
# The onboarding Slack bot

The onboarding assistant is also available in Slack. Mention it in a channel or send it a direct
message; it replies in a thread with an answer, the documents it used, up to four suggested
follow-up questions, and buttons to rate the answer.

## How a question is answered

1. Slack sends the message to an API Gateway endpoint. The ingress Lambda checks the request really
   came from Slack, posts a "Searching the knowledge base…" placeholder, and puts the question on an
   SQS FIFO queue. It has to reply to Slack within three seconds, so it does nothing slower.
2. The worker Lambda takes the question from the queue and runs the same answering flow as
   `sat-cli onboard --chat`: an agent searches the Bedrock Knowledge Base, reads what comes back,
   searches again if it needs to, and writes the answer with Claude Sonnet 4.6 on Amazon Bedrock.
3. The worker replaces the placeholder with the answer.

## Conversations

Each Slack thread is one conversation. Each person's recent questions are remembered in DynamoDB and
carried into their next thread, so a follow-up such as "and how does it fail?" is understood. To
change the subject, start a new thread. In channels the bot must be mentioned every time.

## When something goes wrong

If an answer fails, the worker retries once. If the retry also fails, the placeholder is replaced by
an apology with a reference id; search the worker's CloudWatch logs for that id to find the cause.

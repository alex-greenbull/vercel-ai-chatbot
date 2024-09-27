import 'server-only'
import { OpenAIStream, StreamingTextResponse } from 'ai'
import { Configuration, OpenAIApi } from 'openai-edge'
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import { cookies } from 'next/headers'
import { Database } from '@/lib/db_types'
import { auth } from '@/auth'
import { nanoid } from '@/lib/utils'

export const runtime = 'edge'

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set')
}

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY
})

const openai = new OpenAIApi(configuration)

export async function POST(req: Request) {
  const cookieStore = cookies()
  const supabase = createRouteHandlerClient<Database>({
    cookies: () => cookieStore
  })

  let json
  try {
    json = await req.json()
  } catch (error) {
    console.error('Invalid JSON:', error)
    return new Response('Bad Request: Invalid JSON', { status: 400 })
  }

  const { messages, previewToken, id: requestId } = json

  // Input validation
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response('Bad Request: "messages" must be a non-empty array', {
      status: 400
    })
  }

  // Define the system prompt
  const SYSTEM_PROMPT = {
    role: 'system',
    content: 'reply in french'
  }

  // Prepend the system prompt to the messages
  const messagesWithSystemPrompt = [SYSTEM_PROMPT, ...messages]

  let userId: string | null = null
  try {
    userId = (await auth({ cookieStore }))?.user.id || null
  } catch (error) {
    console.error('Authentication Error:', error)
    return new Response('Internal Server Error', { status: 500 })
  }

  if (!userId) {
    return new Response('Unauthorized', { status: 401 })
  }

  if (previewToken) {
    configuration.apiKey = previewToken
  }

  let res
  try {
    res = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: messagesWithSystemPrompt, // Use the updated messages
      temperature: 0.7,
      stream: true
    })
  } catch (error) {
    console.error('OpenAI API Error:', error)
    return new Response('Internal Server Error: OpenAI API failed', {
      status: 500
    })
  }

  const stream = OpenAIStream(res, {
    async onCompletion(completion) {
      const title = messages[0]?.content.substring(0, 100) || 'Untitled Chat'
      const id = requestId ?? nanoid()
      const createdAt = Date.now()
      const path = `/chat/${id}`
      const payload = {
        id,
        title,
        userId,
        createdAt,
        path,
        messages: [
          ...messages,
          {
            content: completion,
            role: 'assistant'
          }
        ]
      }

      try {
        await supabase.from('chats').upsert({ id, payload }).throwOnError()
      } catch (error) {
        console.error('Supabase Upsert Error:', error)
        // Depending on requirements, you might want to handle this differently
      }
    }
  })

  return new StreamingTextResponse(stream)
}

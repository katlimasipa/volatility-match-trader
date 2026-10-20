CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email) VALUES (NEW.id, NEW.email) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TABLE public.deriv_connections (
  user_id uuid PRIMARY KEY,
  access_token text NOT NULL,
  expires_at timestamptz,
  accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deriv_connections TO authenticated;
GRANT ALL ON public.deriv_connections TO service_role;
ALTER TABLE public.deriv_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own deriv select" ON public.deriv_connections FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own deriv insert" ON public.deriv_connections FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own deriv update" ON public.deriv_connections FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own deriv delete" ON public.deriv_connections FOR DELETE TO authenticated USING (auth.uid() = user_id);
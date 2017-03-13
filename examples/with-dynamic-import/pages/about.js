import Header from '../components/Header'
import Counter from '../components/Counter'

const About = ({ HelloComponent }) => (
  <div>
    <Header />
    <HelloComponent />
    <p>This is the about page.</p>
    <Counter />
  </div>
)

About.getInitialProps = async () => {
  const HelloComponent = await import('../components/hello')
  return { HelloComponent }
}

export default About
